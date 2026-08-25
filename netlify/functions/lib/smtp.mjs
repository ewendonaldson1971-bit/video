import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

function cleanHeader(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function encodedHeader(value) {
  const clean = cleanHeader(value);
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}

function wrapBase64(value) {
  const encoded = Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(String(value), "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") || "";
}

export function buildMessage({ from, to, subject, text, html, inlineImage }) {
  const id = `${crypto.randomUUID()}@${from.address.split("@")[1] || "vivad.video"}`;
  const related = `=_vivad_related_${crypto.randomBytes(12).toString("hex")}`;
  const alternative = `=_vivad_alt_${crypto.randomBytes(12).toString("hex")}`;
  const lines = [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}>`,
    `From: ${encodedHeader(from.name)} <${cleanHeader(from.address)}>`,
    `To: <${cleanHeader(to)}>`,
    `Subject: ${encodedHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${related}"`,
    "",
    `--${related}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "",
    `--${alternative}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(text),
    `--${alternative}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(html),
    `--${alternative}--`,
  ];
  if (inlineImage) {
    lines.push(
      "",
      `--${related}`,
      `Content-Type: ${cleanHeader(inlineImage.contentType || "image/jpeg")}; name="${cleanHeader(inlineImage.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${cleanHeader(inlineImage.cid)}>`,
      `Content-Disposition: inline; filename="${cleanHeader(inlineImage.filename)}"`,
      "",
      wrapBase64(inlineImage.content),
    );
  }
  lines.push(`--${related}--`, "");
  return { id, raw: lines.join("\r\n") };
}

class SmtpReplies {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.current = [];
    this.queue = [];
    this.waiters = [];
    this.error = null;
    this.onData = (chunk) => this.consume(chunk.toString("utf8"));
    this.onError = (error) => this.fail(error);
    this.onClose = () => this.fail(new Error("SMTP connection closed unexpectedly."));
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.current.push(line);
      if (/^\d{3} /.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: this.current.join("\n") };
        this.current = [];
        const waiter = this.waiters.shift();
        waiter ? waiter.resolve(reply) : this.queue.push(reply);
      }
    }
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next() {
    if (this.error) return Promise.reject(this.error);
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }
}

async function expect(replies, allowed, label) {
  const reply = await replies.next();
  if (!allowed.includes(reply.code)) throw new Error(`${label}: ${reply.text}`);
  return reply;
}

async function command(socket, replies, value, allowed, label) {
  socket.write(`${value}\r\n`);
  return expect(replies, allowed, label);
}

async function connectPlain(host, port, timeout) {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(timeout, () => socket.destroy(new Error("SMTP connection timed out.")));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function connectTls(host, port, timeout, socket) {
  const secureSocket = tls.connect({ host: socket ? undefined : host, port: socket ? undefined : port, socket, servername: host, rejectUnauthorized: true });
  secureSocket.setTimeout(timeout, () => secureSocket.destroy(new Error("SMTP TLS connection timed out.")));
  await new Promise((resolve, reject) => {
    secureSocket.once("secureConnect", resolve);
    secureSocket.once("error", reject);
  });
  return secureSocket;
}

export async function sendSmtpMessage({ host, port = 587, secure = false, username, password, from, to, subject, text, html, inlineImage, timeout = 20000 }) {
  if (!host || !username || !password) throw new Error("SMTP is not fully configured.");
  const envelopeFrom = cleanHeader(from.address);
  const envelopeTo = cleanHeader(to);
  const heloName = cleanHeader(process.env.SMTP_HELO_NAME || "vivad-video.netlify.app").replace(/[^a-zA-Z0-9.-]/g, "-");
  const message = buildMessage({ from: { ...from, address: envelopeFrom }, to: envelopeTo, subject, text, html, inlineImage });
  let socket = secure ? await connectTls(host, port, timeout) : await connectPlain(host, port, timeout);
  let replies = new SmtpReplies(socket);
  try {
    await expect(replies, [220], "SMTP greeting failed");
    await command(socket, replies, `EHLO ${heloName}`, [250], "EHLO failed");
    if (!secure) {
      await command(socket, replies, "STARTTLS", [220], "STARTTLS failed");
      replies.detach();
      socket = await connectTls(host, port, timeout, socket);
      replies = new SmtpReplies(socket);
      await command(socket, replies, `EHLO ${heloName}`, [250], "EHLO after STARTTLS failed");
    }
    await command(socket, replies, "AUTH LOGIN", [334], "SMTP authentication was not offered");
    await command(socket, replies, Buffer.from(username).toString("base64"), [334], "SMTP username was rejected");
    await command(socket, replies, Buffer.from(password).toString("base64"), [235], "SMTP password was rejected");
    await command(socket, replies, `MAIL FROM:<${envelopeFrom}>`, [250], "Sender was rejected");
    await command(socket, replies, `RCPT TO:<${envelopeTo}>`, [250, 251], "Recipient was rejected");
    await command(socket, replies, "DATA", [354], "SMTP DATA was rejected");
    const dotStuffed = message.raw.split("\r\n").map((line) => line.startsWith(".") ? `.${line}` : line).join("\r\n");
    socket.write(`${dotStuffed}\r\n.\r\n`);
    await expect(replies, [250], "Message delivery failed");
    await command(socket, replies, "QUIT", [221], "SMTP quit failed").catch(() => {});
    return { messageId: `<${message.id}>` };
  } finally {
    replies.detach();
    socket.end();
  }
}
