import test from "node:test";
import assert from "node:assert/strict";
import { buildMessage } from "../netlify/functions/lib/smtp.mjs";

test("SMTP message contains alternative bodies and an inline preview", () => {
  const message = buildMessage({
    from: { name: "Vivad Video", address: "video@vivad.com.au" },
    to: "customer@example.com",
    subject: "Your video",
    text: "Watch the video",
    html: '<img src="cid:preview">',
    inlineImage: { filename: "preview.jpg", contentType: "image/jpeg", cid: "preview", content: Buffer.from([0xff, 0xd8, 0xff]) },
  });
  assert.match(message.raw, /multipart\/related/);
  assert.match(message.raw, /multipart\/alternative/);
  assert.match(message.raw, /Content-ID: <preview>/);
  assert.match(message.raw, /\/9j\//);
});

test("SMTP message strips newlines from user-controlled headers", () => {
  const message = buildMessage({
    from: { name: "Vivad\r\nBcc: attacker@example.com", address: "video@vivad.com.au" },
    to: "customer@example.com",
    subject: "Your video\r\nBcc: attacker@example.com",
    text: "Text",
    html: "<p>Text</p>",
  });
  assert.doesNotMatch(message.raw, /\r\nBcc:/);
});
