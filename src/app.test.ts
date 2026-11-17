import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, type InboundTextMessage } from "./app.js";
import { createGreetingResponder } from "./greeting.js";

const verifyToken = "test-verify-token";
const appSecret = "test-app-secret";
const whatsappEnvironment = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  GRAPH_API_VERSION: process.env.GRAPH_API_VERSION,
  WHATSAPP_GREETING_REPLY: process.env.WHATSAPP_GREETING_REPLY,
};
const receivedMessages: InboundTextMessage[] = [];
const app = createApp((message) => {
  receivedMessages.push(message);
});
let server: ReturnType<typeof app.listen>;
let baseUrl: string;
const originalVerifyToken = process.env.VERIFY_TOKEN;
const originalAppSecret = process.env.META_APP_SECRET;

before(async () => {
  process.env.VERIFY_TOKEN = verifyToken;
  process.env.META_APP_SECRET = appSecret;
  process.env.WHATSAPP_TOKEN = "test-whatsapp-token";
  process.env.PHONE_NUMBER_ID = "1234567890";
  process.env.GRAPH_API_VERSION = "v21.0";
  process.env.WHATSAPP_GREETING_REPLY = "Welcome!";
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (originalVerifyToken === undefined) {
    delete process.env.VERIFY_TOKEN;
  } else {
    process.env.VERIFY_TOKEN = originalVerifyToken;
  }
  if (originalAppSecret === undefined) {
    delete process.env.META_APP_SECRET;
  } else {
    process.env.META_APP_SECRET = originalAppSecret;
  }
  for (const [key, value] of Object.entries(whatsappEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("GET /health returns a successful JSON health status", async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GET /webhook returns the challenge for a valid subscription request", async () => {
  const query = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": verifyToken,
    "hub.challenge": "challenge-value",
  });
  const response = await fetch(`${baseUrl}/webhook?${query}`);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "challenge-value");
});

test("GET /webhook rejects an invalid verification token", async () => {
  const query = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "wrong-token",
    "hub.challenge": "challenge-value",
  });
  const response = await fetch(`${baseUrl}/webhook?${query}`);

  assert.equal(response.status, 403);
});

function sign(rawBody: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

async function postWebhook(rawBody: string, signature = sign(rawBody)) {
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

function inboundTextPayload(id = "wamid.test-message") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [
                {
                  from: "15551234567",
                  id,
                  timestamp: "1710000000",
                  type: "text",
                  text: { body: "Hello" },
                },
              ],
              metadata: { display_phone_number: "15550000000" },
            },
          },
        ],
      },
    ],
  });
}

test("POST /webhook accepts a valid signature and processes a message ID once", async () => {
  receivedMessages.length = 0;
  const payload = inboundTextPayload();

  assert.equal((await postWebhook(payload)).status, 200);
  assert.equal((await postWebhook(payload)).status, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(receivedMessages, [
    {
      id: "wamid.test-message",
      from: "15551234567",
      displayPhoneNumber: "15550000000",
      text: "Hello",
    },
  ]);
});

test("POST /webhook rejects an invalid signature", async () => {
  receivedMessages.length = 0;
  const response = await postWebhook(
    inboundTextPayload("wamid.invalid-signature"),
    sign('{"object":"not-whatsapp"}'),
  );

  assert.equal(response.status, 401);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(receivedMessages, []);
});

test("POST /webhook validates the exact raw request bytes", async () => {
  const compactPayload = inboundTextPayload("wamid.raw-bytes");
  const response = await postWebhook(` ${compactPayload} `, sign(compactPayload));

  assert.equal(response.status, 401);
});

interface MockRequest {
  url: string;
  init?: RequestInit;
}

function createMockFetch(status = 200, body: BodyInit | null = null): {
  fetchRequest: typeof fetch;
  requests: MockRequest[];
} {
  const requests: MockRequest[] = [];
  const fetchRequest: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(body, { status });
  };

  return { fetchRequest, requests };
}

function makeInboundMessage(
  text: string,
  from = "15551234567",
  displayPhoneNumber = "15550000000",
): InboundTextMessage {
  return {
    id: "wamid.greeting-test",
    from,
    displayPhoneNumber,
    text,
  };
}

test("duplicate webhook events trigger only one greeting response", async () => {
  const { fetchRequest, requests } = createMockFetch();
  const webhookApp = createApp(createGreetingResponder(fetchRequest));
  const webhookServer = webhookApp.listen(0, "127.0.0.1");

  await new Promise<void>((resolve) => webhookServer.once("listening", resolve));
  const address = webhookServer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const url = `http://127.0.0.1:${address.port}/webhook`;
    const body = inboundTextPayload("wamid.duplicate-greeting");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        body,
      });
      assert.equal(response.status, 200);
      await response.text();
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await new Promise<void>((resolve, reject) => {
      webhookServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  assert.equal(requests.length, 1);
});

test("greeting responder sends concise replies only for exact normalized greetings", async () => {
  const { fetchRequest, requests } = createMockFetch();
  const respond = createGreetingResponder(fetchRequest);

  for (const text of [" HI!!! ", "Hello.", "hey?", "GOOD MORNING!!!"]) {
    await respond(makeInboundMessage(text));
  }

  assert.equal(requests.length, 4);
  assert.equal(
    requests[0]?.url,
    "https://graph.facebook.com/v21.0/1234567890/messages",
  );
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    "Bearer test-whatsapp-token",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "15551234567",
    type: "text",
    text: { body: "Welcome!" },
  });
  assert.ok(requests[0]?.init?.signal);
});

test("greeting responder ignores non-greetings and messages from its own number", async () => {
  const { fetchRequest, requests } = createMockFetch();
  const respond = createGreetingResponder(fetchRequest);

  for (const text of ["hi there", "hey bot", "good morning friend", "this is high"]) {
    await respond(makeInboundMessage(text));
  }
  await respond(
    makeInboundMessage(
      "hello",
      "15550000000",
      "+1 (555) 000-0000",
    ),
  );

  assert.equal(requests.length, 0);
});

test("greeting responder handles request timeouts without throwing", async () => {
  const timeoutFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Request timed out", "AbortError")),
        { once: true },
      );
    });
  const respond = createGreetingResponder(timeoutFetch, 1);
  const loggedErrors: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => loggedErrors.push(...values);

  try {
    await assert.doesNotReject(respond(makeInboundMessage("hello")));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(loggedErrors, ["WhatsApp greeting request failed"]);
});

test("greeting responder does not log Graph API response bodies", async () => {
  const { fetchRequest } = createMockFetch(500, "sensitive response content");
  const respond = createGreetingResponder(fetchRequest);
  const loggedErrors: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => loggedErrors.push(...values);

  try {
    await respond(makeInboundMessage("hello"));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(loggedErrors, [
    "WhatsApp greeting request failed with status 500",
  ]);
});

test("POST /webhook rejects malformed JSON", async () => {
  const response = await postWebhook('{"object":');

  assert.equal(response.status, 400);
});

test("POST /webhook rejects malformed payload structure", async () => {
  const response = await postWebhook(JSON.stringify({ object: "not-whatsapp" }));

  assert.equal(response.status, 400);
});

test("POST /webhook acknowledges status-only and unsupported message events", async () => {
  receivedMessages.length = 0;
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              statuses: [{ id: "wamid.status", status: "delivered" }],
              messages: [
                { from: "15551234567", id: "wamid.image", type: "image" },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal((await postWebhook(payload)).status, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(receivedMessages, []);
});
