import type { InboundTextMessage } from "./app.js";

const defaultGreetingReply = "Hello! How can I help?";
const requestTimeoutMs = 10_000;
const greetings = new Set(["hi", "hello", "hey", "good morning"]);

function normalizeGreeting(text: string): string {
  return text
    .trim()
    .replace(/^\p{P}+|\p{P}+$/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizePhoneNumber(phoneNumber: string): string {
  return phoneNumber.replace(/\D/g, "");
}

export function createGreetingResponder(
  fetchRequest: typeof fetch = fetch,
  timeoutMs = requestTimeoutMs,
): (message: InboundTextMessage) => Promise<void> {
  return async (message) => {
    if (
      !greetings.has(normalizeGreeting(message.text)) ||
      normalizePhoneNumber(message.from) ===
        normalizePhoneNumber(message.displayPhoneNumber)
    ) {
      return;
    }

    const accessToken = process.env.WHATSAPP_TOKEN?.trim();
    const phoneNumberId = process.env.PHONE_NUMBER_ID;
    const graphApiVersion = process.env.GRAPH_API_VERSION;
    if (
      !accessToken ||
      !phoneNumberId ||
      !/^\d+$/.test(phoneNumberId) ||
      !graphApiVersion ||
      !/^v\d+\.\d+$/.test(graphApiVersion)
    ) {
      console.error("WhatsApp greeting responder is not configured");
      return;
    }

    const reply =
      process.env.WHATSAPP_GREETING_REPLY?.trim() || defaultGreetingReply;

    try {
      const response = await fetchRequest(
        `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: message.from,
            type: "text",
            text: { body: reply },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (!response.ok) {
        console.error(
          `WhatsApp greeting request failed with status ${response.status}`,
        );
      }
    } catch {
      console.error("WhatsApp greeting request failed");
    }
  };
}
