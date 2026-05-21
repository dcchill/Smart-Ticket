const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const tls = require("tls");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const CSV_PATH = path.join(DATA_DIR, "tickets.csv");
const OUTBOX_PATH = path.join(DATA_DIR, "email-outbox.jsonl");
const CLIENT_FIELD_NAMES = ["requester", "requesterEmail", "departmentId", "deviceId", "impact", "phone", "attemptedFixes", "title", "description"];
const DEFAULT_CLIENT_FIELDS = {
  requester: { enabled: true, required: true },
  requesterEmail: { enabled: true, required: true },
  departmentId: { enabled: true, required: true },
  deviceId: { enabled: true, required: true },
  impact: { enabled: true, required: true },
  phone: { enabled: true, required: false },
  attemptedFixes: { enabled: true, required: false },
  title: { enabled: true, required: true },
  description: { enabled: true, required: true },
};
const DEFAULT_IMPACT_OPTIONS = ["Single user", "Team blocked", "Business critical"];
const DEFAULT_SMART_TAG_RULES = [
  { tag: "wifi", keywords: ["wifi", "wi-fi", "wireless", "wlan", "internet", "network connection", "can't connect", "cannot connect", "connection issue", "connection problem"] },
  { tag: "vpn", keywords: ["vpn", "remote access", "tunnel", "globalprotect", "anyconnect"] },
  { tag: "email", keywords: ["email", "e-mail", "mailbox", "outlook", "gmail", "inbox", "calendar"] },
  { tag: "printer", keywords: ["print", "printer", "scanner", "scan", "copier", "toner", "paper jam", "label printer"] },
  { tag: "login", keywords: ["login", "log in", "sign in", "signin", "account", "locked out", "lockout", "password", "mfa", "2fa", "authentication"] },
  { tag: "hardware", keywords: ["laptop", "desktop", "computer", "monitor", "screen", "keyboard", "mouse", "camera", "webcam", "microphone", "speaker", "charger", "battery"] },
  { tag: "browser", keywords: ["browser", "chrome", "edge", "firefox", "safari", "cache", "cookies", "website", "web site"] },
  { tag: "software", keywords: ["app", "application", "software", "program", "install", "update", "crash", "freezing", "license"] },
  { tag: "classroom display", keywords: ["projector", "smartboard", "smart board", "display", "tv", "hdmi", "promethean", "cleartouch"] },
  { tag: "security", keywords: ["security", "phishing", "malware", "virus", "suspicious", "compromised"] },
];

const defaults = {
  departments: [
    { id: "dept-finance", name: "Finance" },
    { id: "dept-hr", name: "HR" },
    { id: "dept-engineering", name: "Engineering" },
    { id: "dept-sales", name: "Sales" },
    { id: "dept-operations", name: "Operations" },
  ],
  devices: [
    { id: "dev-vpn", name: "VPN", owner: "Network Support" },
    { id: "dev-outlook", name: "Outlook", owner: "Service Desk" },
    { id: "dev-printer", name: "Warehouse printer", owner: "Endpoint Support" },
  ],
  knowledge: [
    { id: "kb-vpn", title: "VPN connection failure", keywords: ["vpn", "remote", "mfa", "tunnel"], fix: "Confirm MFA approval, reset the VPN client profile, flush DNS, and verify remote access group membership." },
    { id: "kb-password", title: "Password or account lockout", keywords: ["password", "locked", "login", "account"], fix: "Unlock the account, force a password reset, check failed login source, and verify MFA methods." },
    { id: "kb-printer", title: "Printer unavailable", keywords: ["printer", "print", "scanner", "label"], fix: "Restart the print spooler, verify network reachability, reinstall the queue, and check device supplies." },
  ],
  settings: {
    adminEmails: [],
    notifyAdmins: true,
    notifyRequesters: true,
    unitType: "departments",
    portalName: "SmartTicket",
    supportContact: "",
    ticketPrefix: "TKT",
    defaultAssignee: "IT Operations",
    defaultStatus: "Open",
    slaHours: { Critical: 4, High: 8, Medium: 24, Low: 72 },
    clientFields: DEFAULT_CLIENT_FIELDS,
    impactOptions: DEFAULT_IMPACT_OPTIONS,
    smartTagRules: DEFAULT_SMART_TAG_RULES,
    adminPasswordHash: "",
    smtp: { host: "", port: 465, user: "", pass: "", from: "", secure: true },
    allowedOrigins: [],
  },
  tickets: [],
};

let store = loadStore();
const adminSessions = new Set();

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/admin-login") return handleAdminLogin(req, res);
    if (url.pathname === "/admin-logout") return handleAdminLogout(res);
    if (url.pathname === "/admin" && !isAdminAuthenticated(req)) return serveStatic(req, res, "/admin-login");
    if (url.pathname.startsWith("/api/")) return await routeApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`SmartTicket running at http://localhost:${PORT}`);
  console.log(`Admin:  http://localhost:${PORT}/admin`);
  console.log(`Client: http://localhost:${PORT}/client`);
});

async function routeApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[1];
  const id = parts[2];

  if (req.method === "POST" && resource === "tickets") return createTicket(req, res, await readTicketInput(req));
  if (req.method === "GET" && resource === "tickets" && id && parts[3] === "lookup") return lookupTicket(res, id, url.searchParams.get("email"));
  if (req.method === "GET" && resource === "client-options") {
    return sendJson(res, 200, {
      departments: store.departments,
      devices: store.devices,
      settings: publicSettings(),
    });
  }

  if (isAdminApi(resource, req.method, id, parts) && !isAdminAuthenticated(req)) {
    return sendJson(res, 401, { error: "Admin password required." });
  }

  if (req.method === "GET" && resource === "tickets" && !id) return sendJson(res, 200, withSla(store.tickets));
  if (req.method === "PUT" && resource === "tickets" && id) return updateTicket(res, id, await readJson(req));
  if (req.method === "DELETE" && resource === "tickets" && id) return deleteTicket(res, id);

  if (["departments", "devices", "knowledge"].includes(resource)) {
    if (req.method === "GET") return sendJson(res, 200, store[resource]);
    if (req.method === "POST") return createCatalogItem(res, resource, await readJson(req));
    if (req.method === "DELETE" && id) return deleteCatalogItem(res, resource, id);
  }

  if (req.method === "GET" && resource === "settings") return sendJson(res, 200, adminSettings());
  if (req.method === "PUT" && resource === "settings") return updateSettings(res, await readJson(req));
  if (req.method === "POST" && resource === "test-email") return sendTestEmail(res);

  sendJson(res, 404, { error: "Route not found" });
}

function createTicket(req, res, payload) {
  const { fields: input, attachments } = payload;
  const fields = clientFieldSettings();
  requireFields(input, CLIENT_FIELD_NAMES.filter((field) => fields[field].enabled && fields[field].required));
  const department = fields.departmentId.enabled ? store.departments.find((item) => item.id === input.departmentId) : null;
  const device = fields.deviceId.enabled ? store.devices.find((item) => item.id === input.deviceId) : null;
  if (fields.departmentId.enabled && input.departmentId && !department) return sendJson(res, 400, { error: "Invalid department or classroom" });
  if (fields.deviceId.enabled && input.deviceId && !device) return sendJson(res, 400, { error: "Invalid device or app" });

  const now = new Date();
  const normalized = normalizeTicketInput(input, department, device);
  const triage = triageTicket(normalized, normalized.deviceRecord);
  const ticket = {
    id: `${sanitizePrefix(store.settings.ticketPrefix)}-${now.getFullYear()}-${crypto.randomInt(1000, 9999)}`,
    requester: normalized.requester,
    requesterEmail: normalized.requesterEmail,
    phone: normalized.phone,
    departmentId: normalized.departmentId,
    department: normalized.department,
    deviceId: normalized.deviceId,
    device: normalized.device,
    impact: normalized.impact,
    attemptedFixes: normalized.attemptedFixes,
    title: normalized.title,
    description: normalized.description,
    status: store.settings.defaultStatus || "Open",
    attachments,
    ...triage,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    internalNotes: [],
    activity: [`${formatDate(now)} - Ticket created by ${displayRequester(normalized)}.`, `${formatDate(now)} - Routed to ${triage.assignee} as ${triage.priority}.`],
  };

  store.tickets.unshift(ticket);
  persist();
  notifyTicketOpened(req, ticket);
  sendJson(res, 201, withSla([ticket])[0]);
}

function lookupTicket(res, id, email) {
  const ticket = store.tickets.find((item) => item.id.toLowerCase() === String(id || "").toLowerCase());
  if (!ticket || ticket.requesterEmail.toLowerCase() !== String(email || "").trim().toLowerCase()) {
    return sendJson(res, 404, { error: "Ticket not found for that email." });
  }

  sendJson(res, 200, {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    assignee: ticket.assignee,
    updatedAt: ticket.updatedAt,
    activity: ticket.activity.slice(0, 8),
  });
}

function deleteTicket(res, id) {
  const ticket = store.tickets.find((item) => item.id === id);
  if (!ticket) return sendJson(res, 404, { error: "Ticket not found" });

  for (const attachment of ticket.attachments || []) {
    const target = path.join(UPLOAD_DIR, path.basename(attachment.storedName || ""));
    if (target.startsWith(UPLOAD_DIR) && fs.existsSync(target)) fs.unlinkSync(target);
  }
  store.tickets = store.tickets.filter((item) => item.id !== id);
  persist();
  sendJson(res, 200, { ok: true });
}

function updateTicket(res, id, patch) {
  const ticket = store.tickets.find((item) => item.id === id);
  if (!ticket) return sendJson(res, 404, { error: "Ticket not found" });

  const allowed = ["status", "priority", "assignee", "category"];
  const changes = [];
  const requesterChanges = [];
  for (const field of allowed) {
    if (patch[field] && patch[field] !== ticket[field]) {
      const change = `${field} changed from ${ticket[field]} to ${patch[field]}`;
      changes.push(change);
      requesterChanges.push(change);
      ticket[field] = patch[field];
    }
  }
  if (patch.note?.trim()) {
    const note = `requester update added: ${patch.note.trim()}`;
    changes.push(note);
    requesterChanges.push(note);
  }
  if (patch.internalNote?.trim()) {
    ticket.internalNotes ||= [];
    ticket.internalNotes.unshift(`${formatDate(new Date())} - ${patch.internalNote.trim()}`);
  }
  if (!changes.length && !patch.internalNote?.trim()) return sendJson(res, 200, withSla([ticket])[0]);

  const now = new Date();
  ticket.updatedAt = now.toISOString();
  if (changes.length) ticket.activity.unshift(`${formatDate(now)} - ${changes.join("; ")}.`);
  persist();
  if (requesterChanges.length) notifyTicketUpdated(ticket, requesterChanges);
  sendJson(res, 200, withSla([ticket])[0]);
}

function createCatalogItem(res, resource, input) {
  if (resource === "departments") requireFields(input, ["name"]);
  if (resource === "devices") requireFields(input, ["name"]);
  if (resource === "knowledge") requireFields(input, ["title", "keywords", "fix"]);

  const item = { id: `${resource.slice(0, -1)}-${Date.now()}` };
  if (resource === "departments") item.name = input.name.trim();
  if (resource === "devices") Object.assign(item, { name: input.name.trim(), owner: input.owner?.trim() || "Service Desk" });
  if (resource === "knowledge") Object.assign(item, { title: input.title.trim(), keywords: splitCsv(input.keywords), fix: input.fix.trim() });
  store[resource].push(item);
  persist();
  sendJson(res, 201, item);
}

function deleteCatalogItem(res, resource, id) {
  store[resource] = store[resource].filter((item) => item.id !== id);
  persist();
  sendJson(res, 200, { ok: true });
}

function updateSettings(res, input) {
  store.settings = {
    ...store.settings,
    adminEmails: splitCsv(input.adminEmails || ""),
    notifyAdmins: Boolean(input.notifyAdmins),
    notifyRequesters: Boolean(input.notifyRequesters),
    unitType: input.unitType === "classrooms" ? "classrooms" : "departments",
    portalName: cleanText(input.portalName, "SmartTicket"),
    supportContact: String(input.supportContact || "").trim(),
    ticketPrefix: sanitizePrefix(input.ticketPrefix),
    defaultAssignee: cleanText(input.defaultAssignee, "IT Operations"),
    defaultStatus: ["Open", "In Progress", "Waiting"].includes(input.defaultStatus) ? input.defaultStatus : "Open",
    slaHours: {
      Critical: cleanNumber(input.slaCritical, 4),
      High: cleanNumber(input.slaHigh, 8),
      Medium: cleanNumber(input.slaMedium, 24),
      Low: cleanNumber(input.slaLow, 72),
    },
    clientFields: readClientFields(input),
    impactOptions: readImpactOptions(input.impactOptions),
    smartTagRules: readSmartTagRules(input.smartTagRules),
    adminPasswordHash: readAdminPasswordHash(input.adminPassword, store.settings.adminPasswordHash),
    smtp: readSmtpSettings(input, store.settings.smtp),
    allowedOrigins: readAllowedOrigins(input.allowedOrigins),
  };
  persist();
  sendJson(res, 200, adminSettings());
}

function triageTicket(ticket, device) {
  const text = `${ticket.title} ${ticket.description} ${device.name}`.toLowerCase();
  const article = store.knowledge.find((item) => item.keywords.some((keyword) => text.includes(keyword.toLowerCase())));
  let score = impactScore(ticket.impact);
  if (/(down|outage|blocked|cannot|failed|offline|security|payroll|critical)/i.test(text)) score += 3;
  if (/(slow|sync|error|missing|issue)/i.test(text)) score += 1;
  const priority = score >= 7 ? "Critical" : score >= 5 ? "High" : score >= 3 ? "Medium" : "Low";
  return {
    priority,
    category: article?.title || "General support",
    assignee: device.owner || store.settings.defaultAssignee || pickAssignee(article?.title || device.name),
    slaHours: store.settings.slaHours?.[priority] || defaults.settings.slaHours[priority],
    recommendation: article?.fix || "Collect logs, confirm scope, reproduce the issue, and document the next support action.",
  };
}

function pickAssignee(text) {
  if (/vpn|network/i.test(text)) return "Network Support";
  if (/password|email|outlook/i.test(text)) return "Service Desk";
  if (/printer|hardware|laptop/i.test(text)) return "Endpoint Support";
  return "IT Operations";
}

function notifyTicketOpened(req, ticket) {
  const subject = `${ticket.id} opened: ${ticket.title}`;
  const unitLabel = store.settings.unitType === "classrooms" ? "Classroom" : "Department";
  const attempted = ticket.attemptedFixes?.length ? `\nAttempted fixes: ${ticket.attemptedFixes.join(", ")}` : "";
  const opener = displayRequester(ticket);
  const body = `${opener} opened ${ticket.id}\nPriority: ${ticket.priority}\n${unitLabel}: ${ticket.department}\nDevice: ${ticket.device}\nRequester: ${ticket.requesterEmail}\nStatus link: ${clientTicketUrl(req, ticket.id)}${attempted}\n\n${ticket.description}`;
  if (store.settings.notifyAdmins) queueEmail(itNotificationRecipients(), subject, body);
  if (store.settings.notifyRequesters) queueEmail([ticket.requesterEmail], `Your IT ticket ${ticket.id} was opened`, `We received your ticket.\n\nStatus: ${ticket.status}\nPriority: ${ticket.priority}\nAssigned to: ${ticket.assignee}\nCheck status: ${clientTicketUrl(req, ticket.id)}${supportLine()}`);
}

function itNotificationRecipients() {
  const smtp = smtpSettings();
  const supportEmail = emailFromText(store.settings.supportContact);
  return [...new Set([
    ...(store.settings.adminEmails || []),
    ...(supportEmail ? [supportEmail] : []),
    ...(smtp.from || smtp.user ? [smtp.from || smtp.user] : []),
  ].filter(Boolean))];
}

function emailFromText(value) {
  return String(value || "").match(/[^\s,;<>]+@[^\s,;<>]+/)?.[0] || "";
}

function notifyTicketUpdated(ticket, changes) {
  if (store.settings.notifyRequesters) queueEmail([ticket.requesterEmail], `Your IT ticket ${ticket.id} was updated`, `Ticket ${ticket.id} was updated:\n${changes.join("\n")}\n\nCurrent status: ${ticket.status}`);
}

function displayRequester(ticket) {
  return ticket.requester && ticket.requester !== "Anonymous requester" ? ticket.requester : ticket.requesterEmail;
}

async function sendTestEmail(res) {
  const smtp = smtpSettings();
  if (!smtp.host) return sendJson(res, 400, { error: "SMTP is not configured. Save Email Delivery settings first." });
  const recipients = store.settings.adminEmails.length ? store.settings.adminEmails : [smtp.from || smtp.user].filter(Boolean);
  if (!recipients.length) return sendJson(res, 400, { error: "Add an admin notification email or SMTP from address first." });

  const message = {
    to: recipients,
    subject: "SmartTicket test email",
    text: `SmartTicket email delivery is configured.\n\nSent at: ${new Date().toISOString()}`,
    at: new Date().toISOString(),
  };
  try {
    await sendSmtp(message, smtp);
    sendJson(res, 200, { message: `Test email sent to ${recipients.join(", ")}.` });
  } catch (error) {
    fs.appendFileSync(OUTBOX_PATH, JSON.stringify({ ...message, sendError: error.message }) + "\n");
    sendJson(res, 500, { error: `Test email failed: ${error.message}` });
  }
}

function queueEmail(to, subject, text) {
  const recipients = (to || []).filter(Boolean);
  if (!recipients.length) return;
  const message = { to: recipients, subject, text, at: new Date().toISOString() };
  sendEmail(message).catch((error) => {
    fs.appendFileSync(OUTBOX_PATH, JSON.stringify({ ...message, sendError: error.message }) + "\n");
  });
}

async function sendEmail(message) {
  const smtp = smtpSettings();
  if (!smtp.host) {
    fs.appendFileSync(OUTBOX_PATH, JSON.stringify({ ...message, queuedOnly: true }) + "\n");
    return;
  }
  await sendSmtp(message, smtp);
}

function sendSmtp(message, smtp) {
  const { host, port, user, pass, from, secure } = smtp;
  if (!from) throw new Error("SMTP_FROM or SMTP_USER is required");

  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect(port, host, { servername: host }) : net.connect(port, host);
    let buffer = "";
    const commands = [
      () => write(`EHLO localhost`),
      () => user && pass ? write(`AUTH LOGIN`) : next(),
      () => user && pass ? write(Buffer.from(user).toString("base64")) : next(),
      () => user && pass ? write(Buffer.from(pass).toString("base64")) : next(),
      () => write(`MAIL FROM:<${from}>`),
      ...message.to.map((recipient) => () => write(`RCPT TO:<${recipient}>`)),
      () => write("DATA"),
      () => writeEmailData(from, message),
      () => write("QUIT"),
    ];
    let index = 0;
    socket.setTimeout(15000);
    socket.on("error", reject);
    socket.on("timeout", () => reject(new Error("SMTP timeout")));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.endsWith("\n")) return;
      const code = Number(buffer.slice(0, 3));
      if (code >= 400) return reject(new Error(buffer.trim()));
      buffer = "";
      next();
    });
    socket.on("end", resolve);
    function next() {
      const command = commands[index++];
      if (command) command();
      else resolve();
    }
    function write(line) { socket.write(`${line}\r\n`); }
    function writeEmailData(fromAddress, item) {
      const headers = [
        `From: ${fromAddress}`,
        `To: ${item.to.join(", ")}`,
        `Subject: ${item.subject}`,
        "Content-Type: text/plain; charset=utf-8",
      ];
      socket.write(`${headers.join("\r\n")}\r\n\r\n${item.text}\r\n.\r\n`);
    }
  });
}

function withSla(tickets) {
  return tickets.map((ticket) => ({ ...ticket, slaState: slaState(ticket), smartTags: smartTags(ticket) }));
}
function slaState(ticket) {
  if (ticket.status === "Resolved") return "Resolved";
  const due = new Date(ticket.createdAt).getTime() + ticket.slaHours * 60 * 60 * 1000;
  const remaining = due - Date.now();
  if (remaining < 0) return "Overdue";
  if (remaining < 2 * 60 * 60 * 1000) return "DueSoon";
  return "OnTrack";
}

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(defaults, null, 2));
    writeCsv(defaults.tickets);
    return structuredClone(defaults);
  }
  const saved = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  return {
    ...structuredClone(defaults),
    ...saved,
    settings: {
      ...defaults.settings,
      ...(saved.settings || {}),
      clientFields: { ...DEFAULT_CLIENT_FIELDS, ...((saved.settings || {}).clientFields || {}) },
      impactOptions: readImpactOptions((saved.settings || {}).impactOptions),
      smartTagRules: readSmartTagRules((saved.settings || {}).smartTagRules),
      adminPasswordHash: (saved.settings || {}).adminPasswordHash || "",
      smtp: { ...defaults.settings.smtp, ...((saved.settings || {}).smtp || {}) },
      allowedOrigins: readAllowedOrigins((saved.settings || {}).allowedOrigins),
    },
  };
}
function persist() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  writeCsv(store.tickets);
}
function writeCsv(tickets) {
  const headers = ["id", "createdAt", "updatedAt", "status", "priority", "requester", "requesterEmail", "department", "device", "title", "assignee", "category", "description", "attemptedFixes", "smartTags", "attachments"];
  const rows = [headers.join(","), ...tickets.map((ticket) => {
    const exportTicket = { ...ticket, smartTags: smartTags(ticket) };
    return headers.map((field) => csv(exportTicket[field])).join(",");
  })];
  fs.writeFileSync(CSV_PATH, rows.join("\n"));
}
function csv(value) {
  const normalized = Array.isArray(value) || (value && typeof value === "object") ? JSON.stringify(value) : value;
  return `"${String(normalized ?? "").replaceAll('"', '""')}"`;
}
function splitCsv(value) { return String(value).split(",").map((item) => item.trim()).filter(Boolean); }
function adminSettings() {
  const smtp = smtpSettings();
  return {
    ...store.settings,
    adminPasswordHash: "",
    adminPasswordSet: Boolean(store.settings.adminPasswordHash || process.env.ADMIN_PASSWORD),
    smtp: { ...store.settings.smtp, pass: store.settings.smtp?.pass ? "" : "" },
    smtpConfigured: Boolean(smtp.host),
    smtpUsingEnvironment: Boolean(process.env.SMTP_HOST),
  };
}
function publicSettings() {
  const { smtp, adminPasswordHash, ...settings } = store.settings;
  return settings;
}
function sanitizePrefix(value) {
  const prefix = String(value || defaults.settings.ticketPrefix).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return prefix || defaults.settings.ticketPrefix;
}
function cleanText(value, fallback) {
  return String(value || "").trim() || fallback;
}
function cleanNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.round(number), 720) : fallback;
}
function readImpactOptions(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  const options = raw
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(options)].slice(0, 20).length ? [...new Set(options)].slice(0, 20) : DEFAULT_IMPACT_OPTIONS;
}
function readSmartTagRules(value) {
  const raw = Array.isArray(value)
    ? value.map((rule) => `${rule.tag}: ${(rule.keywords || []).join(", ")}`).join("\n")
    : String(value || "");
  const rules = raw
    .split(/\r?\n/)
    .map((line) => {
      const [tagPart, keywordsPart] = line.split(":");
      const tag = String(tagPart || "").trim().toLowerCase();
      const keywords = String(keywordsPart || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return tag && keywords.length ? { tag, keywords } : null;
    })
    .filter(Boolean)
    .slice(0, 50);
  return rules.length ? mergeSmartTagRules(rules) : structuredClone(DEFAULT_SMART_TAG_RULES);
}
function mergeSmartTagRules(rules) {
  const merged = new Map();
  for (const rule of rules) {
    const existing = merged.get(rule.tag) || [];
    merged.set(rule.tag, [...new Set([...existing, ...rule.keywords])]);
  }
  return [...merged.entries()].map(([tag, keywords]) => ({ tag, keywords: keywords.slice(0, 40) }));
}
function readAllowedOrigins(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  return [...new Set(raw.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}
function readAdminPasswordHash(value, currentHash = "") {
  const password = String(value || "").trim();
  return password ? hashPassword(password) : currentHash;
}
function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}
function adminPasswordMatches(password) {
  if (process.env.ADMIN_PASSWORD) return password === process.env.ADMIN_PASSWORD;
  if (store.settings.adminPasswordHash) return hashPassword(password) === store.settings.adminPasswordHash;
  return password === "admin";
}
function isAdminAuthenticated(req) {
  const token = parseCookies(req.headers.cookie || "").st_admin;
  return Boolean(token && adminSessions.has(token));
}
function parseCookies(cookieHeader) {
  return String(cookieHeader || "").split(";").reduce((cookies, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (name) cookies[name] = decodeURIComponent(rest.join("="));
    return cookies;
  }, {});
}
async function handleAdminLogin(req, res) {
  const input = await readForm(req);
  if (!adminPasswordMatches(input.password || "")) {
    res.writeHead(302, { Location: "/admin-login?error=1" });
    return res.end();
  }
  const token = crypto.randomUUID();
  adminSessions.add(token);
  res.writeHead(302, {
    Location: "/admin",
    "Set-Cookie": `st_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
  });
  res.end();
}
function handleAdminLogout(res) {
  res.writeHead(302, {
    Location: "/admin-login",
    "Set-Cookie": "st_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
  });
  res.end();
}
function isAdminApi(resource, method, id, parts) {
  if (resource === "client-options") return false;
  if (resource === "tickets" && method === "POST") return false;
  if (resource === "tickets" && method === "GET" && id && parts[3] === "lookup") return false;
  return true;
}
async function readForm(req) {
  const body = (await readBuffer(req)).toString("utf8");
  return Object.fromEntries(new URLSearchParams(body).entries());
}
function readSmtpSettings(input, current = {}) {
  const host = String(input.smtpHost || "").trim();
  const user = String(input.smtpUser || "").trim();
  const from = String(input.smtpFrom || "").trim();
  const passInput = String(input.smtpPass || "");
  return {
    host,
    port: cleanPort(input.smtpPort, 465),
    user,
    pass: passInput ? passInput : (current.pass || ""),
    from,
    secure: Boolean(input.smtpSecure),
  };
}
function smtpSettings() {
  const saved = store.settings.smtp || {};
  const host = process.env.SMTP_HOST || saved.host || "";
  const user = process.env.SMTP_USER || saved.user || "";
  return {
    host,
    port: Number(process.env.SMTP_PORT || saved.port || 465),
    user,
    pass: process.env.SMTP_PASS || saved.pass || "",
    from: process.env.SMTP_FROM || saved.from || user,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== "false" : saved.secure !== false,
  };
}
function cleanPort(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : fallback;
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = [
    ...readAllowedOrigins(process.env.CORS_ORIGINS || ""),
    ...readAllowedOrigins(store?.settings?.allowedOrigins || []),
  ];
  if (!allowed.includes("*") && !allowed.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function impactScore(impact) {
  if (impact === "Business critical") return 5;
  if (impact === "Team blocked") return 3;
  const options = readImpactOptions(store.settings.impactOptions);
  const index = options.findIndex((option) => option === impact);
  if (index < 0 || options.length <= 1) return 1;
  return Math.round(1 + (index / (options.length - 1)) * 4);
}
function smartTags(ticket) {
  const text = normalizeSearchText([
    ticket.device,
    ticket.title,
    ticket.description,
    ticket.category,
    ...(ticket.attemptedFixes || []),
  ].join(" "));
  const tags = smartTagRules().filter((rule) => rule.keywords.some((keyword) => text.includes(normalizeSearchText(keyword)))).map((rule) => rule.tag);
  return tags.length ? [...new Set(tags)] : ["general"];
}
function smartTagRules() {
  return readSmartTagRules(store.settings.smartTagRules);
}
function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function supportLine() {
  return store.settings.supportContact ? `\nSupport contact: ${store.settings.supportContact}` : "";
}
function clientTicketUrl(req, ticketId) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}/client?ticket=${encodeURIComponent(ticketId)}`;
}
function readClientFields(input) {
  const fields = {};
  for (const field of CLIENT_FIELD_NAMES) {
    const enabled = Boolean(input[`field_${field}_enabled`]);
    fields[field] = {
      enabled,
      required: enabled && Boolean(input[`field_${field}_required`]),
    };
  }
  return fields;
}
function clientFieldSettings() {
  return { ...DEFAULT_CLIENT_FIELDS, ...(store.settings.clientFields || {}) };
}
function normalizeTicketInput(input, department, device) {
  const deviceRecord = device || { id: "", name: "General IT request", owner: store.settings.defaultAssignee };
  const impacts = readImpactOptions(store.settings.impactOptions);
  return {
    requester: String(input.requester || "").trim() || "Anonymous requester",
    requesterEmail: String(input.requesterEmail || "").trim(),
    phone: String(input.phone || "").trim(),
    departmentId: department?.id || "",
    department: department?.name || "Unassigned",
    deviceId: device?.id || "",
    device: device?.name || "General IT request",
    deviceRecord,
    impact: impacts.includes(input.impact) ? input.impact : impacts[0],
    attemptedFixes: readAttemptedFixSelections(input.attemptedFixes),
    title: String(input.title || "").trim() || "IT support request",
    description: String(input.description || "").trim() || "No description provided.",
  };
}
function readAttemptedFixSelections(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  const selections = raw
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(selections)].slice(0, 20);
}
function requireFields(input, fields) {
  const missing = fields.filter((field) => !String(input[field] ?? "").trim());
  if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}`);
}
function formatDate(date) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}
async function readTicketInput(req) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return { fields: await readJson(req), attachments: [] };
  }

  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("Missing multipart boundary");
  const body = await readBuffer(req);
  return parseMultipart(body, boundary);
}
function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function parseMultipart(body, boundary) {
  const fields = {};
  const attachments = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let start = body.indexOf(delimiter);

  while (start !== -1) {
    start += delimiter.length;
    if (body.slice(start, start + 2).toString() === "--") break;
    if (body.slice(start, start + 2).toString() === "\r\n") start += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next === -1) break;

    const headers = body.slice(start, headerEnd).toString("utf8");
    const content = body.slice(headerEnd + 4, Math.max(headerEnd + 4, next - 2));
    const name = headers.match(/name="([^"]+)"/)?.[1];
    const filename = headers.match(/filename="([^"]*)"/)?.[1];

    if (name && filename) {
      const saved = saveAttachment(filename, content);
      if (saved) attachments.push(saved);
    } else if (name) {
      appendMultipartField(fields, name, content.toString("utf8"));
    }
    start = next;
  }

  return { fields, attachments };
}
function appendMultipartField(fields, name, value) {
  if (Object.prototype.hasOwnProperty.call(fields, name)) {
    fields[name] = Array.isArray(fields[name]) ? [...fields[name], value] : [fields[name], value];
  } else {
    fields[name] = value;
  }
}
function saveAttachment(filename, content) {
  if (!filename || !content.length) return null;
  if (content.length > 10 * 1024 * 1024) throw new Error("Attachment is larger than 10 MB");
  const originalName = path.basename(filename).replace(/[^\w.\- ()]/g, "_");
  const ext = path.extname(originalName).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), content);
  return {
    originalName,
    storedName,
    size: content.length,
    url: `/uploads/${storedName}`,
  };
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function serveStatic(req, res, pathname) {
  if ((pathname === "/data/tickets.csv" || pathname === "/data/store.json" || pathname === "/data/email-outbox.jsonl") && !isAdminAuthenticated(req)) {
    res.writeHead(302, { Location: "/admin-login" });
    return res.end();
  }
  const routes = { "/": "client.html", "/admin": "index.html", "/admin-login": "admin-login.html", "/client": "client.html" };
  const file = routes[pathname] || pathname.slice(1);
  const fullPath = path.normalize(path.join(ROOT, file));
  if (!fullPath.startsWith(ROOT) || !fs.existsSync(fullPath)) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const types = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".csv": "text/csv" };
  res.writeHead(200, { "Content-Type": types[path.extname(fullPath)] || "application/octet-stream" });
  fs.createReadStream(fullPath).pipe(res);
}
