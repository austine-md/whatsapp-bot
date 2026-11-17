import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { createGreetingResponder } from "./greeting.js";

export interface InboundTextMessage {
  id: string;
  from: string;
  displayPhoneNumber: string;
  text: string;
}

type InboundTextMessageHandler = (
  message: InboundTextMessage,
) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesToken(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function hasValidSignature(
  rawBody: Buffer,
  signature: string | undefined,
  appSecret: string,
): boolean {
  if (!signature || !/^sha256=[a-f\d]{64}$/i.test(signature)) {
    return false;
  }

  const providedDigest = Buffer.from(signature.slice("sha256=".length), "hex");
  const expectedDigest = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest();

  return (
    providedDigest.length === expectedDigest.length &&
    timingSafeEqual(providedDigest, expectedDigest)
  );
}

function extractTextMessages(payload: unknown): InboundTextMessage[] | null {
  if (
    !isRecord(payload) ||
    payload.object !== "whatsapp_business_account" ||
    !Array.isArray(payload.entry)
  ) {
    return null;
  }

  const textMessages: InboundTextMessage[] = [];

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) {
      return null;
    }

    for (const change of entry.changes) {
      if (!isRecord(change) || typeof change.field !== "string") {
        return null;
      }

      if (change.field !== "messages") {
        continue;
      }

      if (!isRecord(change.value)) {
        return null;
      }

      const messages = change.value.messages;
      if (messages === undefined) {
        continue;
      }
      if (!Array.isArray(messages)) {
        return null;
      }

      for (const message of messages) {
        if (!isRecord(message) || typeof message.type !== "string") {
          return null;
        }
        if (message.type !== "text") {
          continue;
        }

        if (
          typeof message.id !== "string" ||
          message.id.length === 0 ||
          typeof message.from !== "string" ||
          message.from.length === 0 ||
          !isRecord(change.value.metadata) ||
          typeof change.value.metadata.display_phone_number !== "string" ||
          change.value.metadata.display_phone_number.length === 0 ||
          !isRecord(message.text) ||
          typeof message.text.body !== "string"
        ) {
          return null;
        }

        textMessages.push({
          id: message.id,
          from: message.from,
          displayPhoneNumber: change.value.metadata.display_phone_number,
          text: message.text.body,
        });
      }
    }
  }

  return textMessages;
}

export function createApp(
  onInboundTextMessage?: InboundTextMessageHandler,
) {
  const app = express();
  const processedMessageIds = new Set<string>();

  app.disable("x-powered-by");

  app.get("/webhook", (request, response) => {
    const verifyToken = process.env.VERIFY_TOKEN;
    if (!verifyToken) {
      response.status(500).send("Webhook verification is not configured");
      return;
    }

    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];

    if (
      mode !== "subscribe" ||
      typeof token !== "string" ||
      !matchesToken(token, verifyToken) ||
      typeof challenge !== "string"
    ) {
      response.sendStatus(403);
      return;
    }

    response.type("text/plain").status(200).send(challenge);
  });

  app.post(
    "/webhook",
    express.raw({ type: "application/json", inflate: false }),
    (request, response) => {
      const appSecret = process.env.META_APP_SECRET;
      if (!appSecret) {
        response.status(500).send("Webhook signature validation is not configured");
        return;
      }

      if (
        !Buffer.isBuffer(request.body) ||
        !hasValidSignature(
          request.body,
          request.get("x-hub-signature-256"),
          appSecret,
        )
      ) {
        response.sendStatus(401);
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(request.body.toString("utf8"));
      } catch {
        response.status(400).send("Malformed webhook payload");
        return;
      }

      const messages = extractTextMessages(payload);
      if (!messages) {
        response.status(400).send("Malformed webhook payload");
        return;
      }

      const newMessages = messages.filter((message) => {
        if (processedMessageIds.has(message.id)) {
          return false;
        }
        processedMessageIds.add(message.id);
        return true;
      });

      response.sendStatus(200);

      if (onInboundTextMessage) {
        setImmediate(() => {
          for (const message of newMessages) {
            Promise.resolve()
              .then(() => onInboundTextMessage(message))
              .catch(() => {
                console.error("Inbound WhatsApp message processing failed");
              });
          }
        });
      }
    },
  );

  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  return app;
}

export default createApp(createGreetingResponder());
