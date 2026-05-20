const state = {
  tickets: [],
  departments: [],
  devices: [],
  knowledge: [],
  settings: {},
  selectedTicketId: null,
};

const statuses = ["Open", "In Progress", "Waiting", "Resolved"];
const priorities = ["Critical", "High", "Medium", "Low"];
const clientFields = ["requester", "requesterEmail", "departmentId", "deviceId", "impact", "phone", "title", "description"];

document.addEventListener("DOMContentLoaded", async () => {
  if (document.body.dataset.app === "client") {
    await initClient();
  } else {
    await initAdmin();
  }
});

async function initAdmin() {
  bindAdminNav();
  fillSelect(document.querySelector("#statusFilter"), ["all", ...statuses]);
  fillSelect(document.querySelector("#priorityFilter"), ["all", ...priorities]);
  document.querySelector("#searchInput").addEventListener("input", renderTickets);
  document.querySelector("#statusFilter").addEventListener("change", renderTickets);
  document.querySelector("#priorityFilter").addEventListener("change", renderTickets);
  document.querySelector("#departmentForm").addEventListener("submit", createDepartment);
  document.querySelector("#deviceForm").addEventListener("submit", createDevice);
  document.querySelector("#knowledgeForm").addEventListener("submit", createKnowledge);
  document.querySelector("#settingsForm").addEventListener("submit", saveSettings);
  await refreshData();
}

async function initClient() {
  await refreshData();
  const ticketForm = document.querySelector("#clientTicketForm");
  const attachmentInput = document.querySelector("#clientAttachments");
  ticketForm.addEventListener("submit", submitClientTicket);
  ticketForm.addEventListener("reset", () => window.setTimeout(renderSelectedFiles, 0));
  attachmentInput?.addEventListener("change", renderSelectedFiles);
  document.querySelector("#ticketLookupForm").addEventListener("submit", lookupTicket);
  prefillTicketLookup();
  renderClientCatalog();
}

async function refreshData() {
  if (document.body.dataset.app === "client") {
    const catalog = await api("/api/client-options");
    Object.assign(state, { departments: catalog.departments, devices: catalog.devices, settings: catalog.settings });
    return;
  }

  const [tickets, departments, devices, knowledge, settings] = await Promise.all([
    api("/api/tickets"),
    api("/api/departments"),
    api("/api/devices"),
    api("/api/knowledge"),
    api("/api/settings"),
  ]);
  Object.assign(state, { tickets, departments, devices, knowledge, settings });
  state.selectedTicketId ||= tickets[0]?.id ?? null;
  renderAdmin();
}

function renderAdmin() {
  applyUnitLabels();
  renderMetrics();
  renderDashboard();
  renderTickets();
  renderCatalog();
  renderKnowledge();
  renderSettings();
}

function bindAdminNav() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
      document.querySelector(`#${button.dataset.view}View`).classList.add("active");
    });
  });
}

function renderMetrics() {
  setText("#openCount", state.tickets.filter((ticket) => ticket.status !== "Resolved").length);
  setText("#criticalCount", state.tickets.filter((ticket) => ticket.priority === "Critical").length);
  setText("#waitingCount", state.tickets.filter((ticket) => ticket.status === "Waiting").length);
  setText("#resolvedCount", state.tickets.filter((ticket) => ticket.status === "Resolved").length);
}

function renderTickets() {
  const list = document.querySelector("#ticketList");
  const detail = document.querySelector("#ticketDetail");
  const tickets = filteredTickets();

  if (!tickets.length) {
    list.innerHTML = `<div class="empty-state">No tickets match the current filters.</div>`;
    detail.innerHTML = `<div class="empty-state">Select a ticket to inspect details.</div>`;
    return;
  }

  if (!tickets.some((ticket) => ticket.id === state.selectedTicketId)) state.selectedTicketId = tickets[0].id;
  list.innerHTML = tickets.map(ticketCard).join("");
  list.querySelectorAll("[data-ticket-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTicketId = button.dataset.ticketId;
      renderTickets();
    });
  });

  const ticket = state.tickets.find((item) => item.id === state.selectedTicketId);
  detail.innerHTML = ticketDetail(ticket);
  detail.querySelectorAll("[data-update-field]").forEach((control) => {
    control.addEventListener("change", () => updateTicket(ticket.id, { [control.dataset.updateField]: control.value }));
  });
  detail.querySelector("#noteForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const note = new FormData(event.currentTarget).get("note");
    updateTicket(ticket.id, { note });
    event.currentTarget.reset();
  });
}

function ticketCard(ticket) {
  return `
    <button class="ticket-card ${ticket.id === state.selectedTicketId ? "active" : ""}" type="button" data-ticket-id="${ticket.id}">
      <div class="ticket-card-header">
        <div>
          <h3>${escapeHtml(ticket.title)}</h3>
          <p>${escapeHtml(ticket.requester)} | ${escapeHtml(ticket.department)} | ${escapeHtml(ticket.device)}</p>
        </div>
        <span class="pill ${ticket.priority}">${ticket.priority}</span>
      </div>
      <div class="meta-line">
        <span class="pill ${compact(ticket.status)}">${ticket.status}</span>
        <span class="pill ${ticket.slaState}">${ticket.slaState}</span>
        <span class="pill">${ticket.assignee}</span>
      </div>
    </button>`;
}

function ticketDetail(ticket) {
  if (!ticket) return `<div class="empty-state">Select a ticket to inspect details.</div>`;
  return `
    <div class="detail-header">
      <div>
        <span class="eyebrow">${ticket.id}</span>
        <h2>${escapeHtml(ticket.title)}</h2>
        <p>${escapeHtml(ticket.description)}</p>
      </div>
      <span class="pill ${ticket.priority}">${ticket.priority}</span>
    </div>
    <div class="detail-section">
      <div class="form-grid">
        <label><span>Status</span><select data-update-field="status">${optionList(statuses, ticket.status)}</select></label>
        <label><span>Priority</span><select data-update-field="priority">${optionList(priorities, ticket.priority)}</select></label>
        <label><span>Assignee</span><input data-update-field="assignee" value="${escapeAttr(ticket.assignee)}" /></label>
        <label><span>Category</span><input data-update-field="category" value="${escapeAttr(ticket.category)}" /></label>
      </div>
    </div>
    <div class="detail-section">
      <h3>Smart recommendation</h3>
      <div class="recommendation">${escapeHtml(ticket.recommendation)}</div>
      <p>Requester email: ${escapeHtml(ticket.requesterEmail)}. SLA target: ${ticket.slaHours} hours.</p>
    </div>
    <div class="detail-section">
      <h3>Attachments</h3>
      ${attachmentList(ticket.attachments)}
    </div>
    <div class="detail-section">
      <h3>Add update</h3>
      <form class="stack-form" id="noteForm">
        <textarea name="note" placeholder="Add a note for the ticket history and requester email."></textarea>
        <button class="primary-action" type="submit">Post update</button>
      </form>
    </div>
    <div class="detail-section">
      <h3>Status history</h3>
      <ol class="activity timeline">${ticket.activity.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
    </div>`;
}

function renderDashboard() {
  const target = document.querySelector("#insightGrid");
  if (!target) return;
  const tickets = state.tickets;
  const resolved = tickets.filter((ticket) => ticket.status === "Resolved");
  const open = tickets.filter((ticket) => ticket.status !== "Resolved");
  const overdue = tickets.filter((ticket) => ticket.slaState === "Overdue").length;
  const avgHours = resolved.length
    ? Math.round(resolved.reduce((sum, ticket) => sum + ((new Date(ticket.updatedAt) - new Date(ticket.createdAt)) / 36e5), 0) / resolved.length)
    : 0;
  target.innerHTML = `
    <article class="insight-card"><span>Open tickets</span><strong>${open.length}</strong></article>
    <article class="insight-card"><span>Overdue</span><strong>${overdue}</strong></article>
    <article class="insight-card"><span>Avg resolution</span><strong>${avgHours}h</strong></article>
    <article class="insight-card"><span>Attachments</span><strong>${tickets.reduce((sum, ticket) => sum + (ticket.attachments?.length || 0), 0)}</strong></article>
    <article class="insight-card">${barList("Top devices/apps", countBy(tickets, "device"))}</article>
    <article class="insight-card">${barList("Common statuses", countBy(tickets, "status"))}</article>
    <article class="insight-card">${barList("Busy assignees", countBy(tickets, "assignee"))}</article>
    <article class="insight-card">${barList("Frequent keywords", keywordCounts(tickets))}</article>
  `;
}

function renderCatalog() {
  applyUnitLabels();
  document.querySelector("#departmentList").innerHTML = state.departments.length
    ? state.departments.map((department) => row(department.name, department.id, "departments")).join("")
    : `<div class="empty-state">No ${unitWords().pluralLower} configured.</div>`;
  document.querySelector("#deviceList").innerHTML = state.devices
    .map((device) => row(device.name, device.id, "devices", device.owner))
    .join("") || `<div class="empty-state">No devices or apps configured.</div>`;
  bindDeletes();
}

function renderKnowledge() {
  document.querySelector("#knowledgeGrid").innerHTML = state.knowledge
    .map((article) => `
      <article class="panel">
        <div class="row-between">
          <h3>${escapeHtml(article.title)}</h3>
          <button class="danger-action" type="button" data-delete-kind="knowledge" data-delete-id="${article.id}">Delete</button>
        </div>
        <p>${escapeHtml(article.fix)}</p>
        <div class="tag-row">${article.keywords.map((word) => `<span class="pill">${escapeHtml(word)}</span>`).join("")}</div>
      </article>`)
    .join("");
  bindDeletes();
}

function renderSettings() {
  const form = document.querySelector("#settingsForm");
  form.portalName.value = state.settings.portalName ?? "SmartTicket";
  form.supportContact.value = state.settings.supportContact ?? "";
  form.unitType.value = state.settings.unitType ?? "departments";
  form.ticketPrefix.value = state.settings.ticketPrefix ?? "TKT";
  form.defaultAssignee.value = state.settings.defaultAssignee ?? "IT Operations";
  form.defaultStatus.value = state.settings.defaultStatus ?? "Open";
  form.slaCritical.value = state.settings.slaHours?.Critical ?? 4;
  form.slaHigh.value = state.settings.slaHours?.High ?? 8;
  form.slaMedium.value = state.settings.slaHours?.Medium ?? 24;
  form.slaLow.value = state.settings.slaHours?.Low ?? 72;
  form.impactOptions.value = impactOptions().join("\n");
  form.allowedOrigins.value = state.settings.allowedOrigins?.join("\n") ?? "";
  form.adminEmails.value = state.settings.adminEmails?.join(", ") ?? "";
  form.notifyAdmins.checked = Boolean(state.settings.notifyAdmins);
  form.notifyRequesters.checked = Boolean(state.settings.notifyRequesters);
  clientFields.forEach((field) => {
    const config = fieldConfig(field);
    const enabled = form.elements[`field_${field}_enabled`];
    const required = form.elements[`field_${field}_required`];
    if (enabled) enabled.checked = config.enabled;
    if (required) required.checked = config.required;
  });
  setText("#emailStatus", state.settings.smtpConfigured ? "SMTP is configured. Emails will be sent." : "SMTP is not configured. Emails are saved to data/email-outbox.jsonl.");
}

function renderClientCatalog() {
  applyUnitLabels();
  const portalName = state.settings.portalName ?? "SmartTicket";
  document.querySelectorAll("[data-portal-name]").forEach((element) => {
    element.textContent = portalName;
  });
  const supportText = state.settings.supportContact
    ? `Send issues directly to IT. Support contact: ${state.settings.supportContact}.`
    : "Send issues directly to IT with smart routing and email updates.";
  setText("#clientSupportText", supportText);
  fillSelect(document.querySelector("#clientDepartment"), state.departments.map((department) => [department.id, department.name]));
  if (!state.departments.length) {
    fillSelect(document.querySelector("#clientDepartment"), [["", `No ${unitWords().pluralLower} configured`]]);
  }
  fillSelect(document.querySelector("#clientDevice"), state.devices.length ? state.devices.map((device) => [device.id, device.name]) : [["", "No devices or apps configured"]]);
  fillSelect(document.querySelector("#clientImpact"), impactOptions().map((option) => [option, option]));
  applyClientFieldSettings();
}

async function submitClientTicket(event) {
  event.preventDefault();
  const notice = document.querySelector("#clientNotice");
  const submitButton = document.querySelector("#clientSubmitButton");
  const originalText = submitButton?.textContent || "Submit ticket";
  try {
    if (!validateSelectedFiles()) return;
    setClientSubmitting(true);
    const formData = new FormData(event.currentTarget);
    const response = await fetch("/api/tickets", { method: "POST", body: formData });
    const ticket = await response.json();
    if (!response.ok) throw new Error(ticket.error ?? "Request failed");
    event.currentTarget.reset();
    renderSelectedFiles();
    renderClientCatalog();
    notice.className = "notice success";
    notice.innerHTML = ticketConfirmation(ticket);
    notice.querySelector("[data-copy-ticket]")?.addEventListener("click", () => copyTicketId(ticket.id));
  } catch (error) {
    notice.className = "notice error";
    notice.textContent = error.message;
  } finally {
    setClientSubmitting(false, originalText);
  }
}

async function lookupTicket(event) {
  event.preventDefault();
  const result = document.querySelector("#ticketLookupResult");
  const data = new FormData(event.currentTarget);
  try {
    const ticket = await api(`/api/tickets/${encodeURIComponent(data.get("ticketId"))}/lookup?email=${encodeURIComponent(data.get("email"))}`);
    result.innerHTML = `
      <div class="notice success">Ticket found.</div>
      <div class="table-list">
        <div class="table-row"><span><strong>${escapeHtml(ticket.id)}</strong><br />${escapeHtml(ticket.title)}</span><span class="pill ${ticket.priority}">${ticket.priority}</span></div>
        <div class="table-row"><span>Status</span><strong>${escapeHtml(ticket.status)}</strong></div>
        <div class="table-row"><span>Assigned to</span><strong>${escapeHtml(ticket.assignee)}</strong></div>
        <div class="table-row"><span>Last updated</span><strong>${escapeHtml(formatDateTime(ticket.updatedAt))}</strong></div>
      </div>
      <ol class="activity timeline">${ticket.activity.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
    `;
  } catch (error) {
    result.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  }
}

async function createDepartment(event) {
  event.preventDefault();
  await submitCatalogForm(event.currentTarget, "/api/departments", "#departmentNotice", "Department added.");
}

async function createDevice(event) {
  event.preventDefault();
  await submitCatalogForm(event.currentTarget, "/api/devices", "#deviceNotice", "Device/app added.");
}

async function createKnowledge(event) {
  event.preventDefault();
  await api("/api/knowledge", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) });
  event.currentTarget.reset();
  await refreshData();
}

async function saveSettings(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  data.notifyAdmins = event.currentTarget.notifyAdmins.checked;
  data.notifyRequesters = event.currentTarget.notifyRequesters.checked;
  clientFields.forEach((field) => {
    data[`field_${field}_enabled`] = event.currentTarget.elements[`field_${field}_enabled`]?.checked ?? false;
    data[`field_${field}_required`] = event.currentTarget.elements[`field_${field}_required`]?.checked ?? false;
  });
  await api("/api/settings", { method: "PUT", body: data });
  await refreshData();
}

async function updateTicket(id, patch) {
  await api(`/api/tickets/${id}`, { method: "PUT", body: patch });
  await refreshData();
}

function bindDeletes() {
  document.querySelectorAll("[data-delete-kind]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/${button.dataset.deleteKind}/${button.dataset.deleteId}`, { method: "DELETE" });
        await refreshData();
        setNotice("#departmentNotice", "Option removed.", "success");
        setNotice("#deviceNotice", "Option removed.", "success");
      } catch (error) {
        setNotice("#departmentNotice", error.message, "error");
        setNotice("#deviceNotice", error.message, "error");
      }
    });
  });
}

async function submitCatalogForm(form, path, noticeSelector, successMessage) {
  try {
    await api(path, { method: "POST", body: Object.fromEntries(new FormData(form)) });
    form.reset();
    await refreshData();
    setNotice(noticeSelector, successMessage, "success");
  } catch (error) {
    setNotice(noticeSelector, error.message, "error");
  }
}

function filteredTickets() {
  const query = document.querySelector("#searchInput").value.trim().toLowerCase();
  const status = document.querySelector("#statusFilter").value;
  const priority = document.querySelector("#priorityFilter").value;
  return state.tickets.filter((ticket) => {
    const haystack = `${ticket.id} ${ticket.title} ${ticket.description} ${ticket.requester} ${ticket.requesterEmail} ${ticket.department} ${ticket.device}`.toLowerCase();
    return (!query || haystack.includes(query)) && (status === "all" || ticket.status === status) && (priority === "all" || ticket.priority === priority);
  });
}

function row(title, id, kind, subtitle = "") {
  return `<div class="table-row"><span><strong>${escapeHtml(title)}</strong><br />${escapeHtml(subtitle)}</span><button class="danger-action" type="button" data-delete-kind="${kind}" data-delete-id="${id}">Delete</button></div>`;
}

function departmentName(id) {
  return state.departments.find((department) => department.id === id)?.name ?? "Unassigned";
}

function applyUnitLabels() {
  const words = unitWords();
  document.querySelectorAll("[data-unit-singular]").forEach((element) => {
    element.textContent = words.singular;
  });
  document.querySelectorAll("[data-unit-plural]").forEach((element) => {
    element.textContent = words.plural;
  });
}

function unitWords() {
  const classrooms = state.settings.unitType === "classrooms";
  return classrooms
    ? { singular: "Classroom", plural: "Classrooms", pluralLower: "classrooms" }
    : { singular: "Department", plural: "Departments", pluralLower: "departments" };
}

function applyClientFieldSettings() {
  clientFields.forEach((field) => {
    const element = document.querySelector(`[data-client-field="${field}"]`);
    if (!element) return;
    const config = fieldConfig(field);
    element.hidden = !config.enabled;
    element.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !config.enabled;
      control.required = config.enabled && config.required;
    });
  });
}

function prefillTicketLookup() {
  const ticketId = new URLSearchParams(window.location.search).get("ticket");
  const input = document.querySelector("#lookupTicketId");
  if (ticketId && input) input.value = ticketId;
}

function renderSelectedFiles() {
  const input = document.querySelector("#clientAttachments");
  const target = document.querySelector("#clientFileList");
  if (!input || !target) return;
  const files = Array.from(input.files || []);
  target.innerHTML = files.length
    ? files.map((file) => `<div>${escapeHtml(file.name)} <span>${formatFileSize(file.size)}</span></div>`).join("")
    : "";
}

function validateSelectedFiles() {
  const input = document.querySelector("#clientAttachments");
  const notice = document.querySelector("#clientNotice");
  const oversized = Array.from(input?.files || []).filter((file) => file.size > 10 * 1024 * 1024);
  if (!oversized.length) return true;
  notice.className = "notice error";
  notice.textContent = `${oversized[0].name} is larger than the 10 MB attachment limit.`;
  return false;
}

function setClientSubmitting(isSubmitting, label = "Submit ticket") {
  const form = document.querySelector("#clientTicketForm");
  const submitButton = document.querySelector("#clientSubmitButton");
  form?.querySelectorAll("button, input, select, textarea").forEach((control) => {
    if (isSubmitting) {
      control.dataset.wasDisabled = control.disabled ? "true" : "false";
      control.disabled = true;
    } else {
      control.disabled = control.dataset.wasDisabled === "true";
      delete control.dataset.wasDisabled;
    }
  });
  if (submitButton) submitButton.textContent = isSubmitting ? "Submitting..." : label;
}

function ticketConfirmation(ticket) {
  const emailLine = state.settings.notifyRequesters === false ? "Save this ticket ID for status checks." : "We emailed you a confirmation and will send updates as the ticket changes.";
  const responseLine = ticket.slaHours ? `Target response window: ${ticket.slaHours} hours.` : "IT will review your request as soon as possible.";
  return `
    <div class="confirmation">
      <strong>Ticket ${escapeHtml(ticket.id)} was submitted.</strong>
      <p>${escapeHtml(emailLine)}</p>
      <p>${escapeHtml(responseLine)}</p>
      <button class="secondary-action" type="button" data-copy-ticket>Copy ticket ID</button>
    </div>`;
}

async function copyTicketId(ticketId) {
  const button = document.querySelector("[data-copy-ticket]");
  try {
    await navigator.clipboard.writeText(ticketId);
    if (button) button.textContent = "Copied";
  } catch {
    if (button) button.textContent = ticketId;
  }
}

function fieldConfig(field) {
  const defaults = defaultClientFields();
  return { ...defaults[field], ...(state.settings.clientFields?.[field] || {}) };
}

function defaultClientFields() {
  return {
    requester: { enabled: true, required: true },
    requesterEmail: { enabled: true, required: true },
    departmentId: { enabled: true, required: true },
    deviceId: { enabled: true, required: true },
    impact: { enabled: true, required: true },
    phone: { enabled: true, required: false },
    title: { enabled: true, required: true },
    description: { enabled: true, required: true },
  };
}

function impactOptions() {
  return Array.isArray(state.settings.impactOptions) && state.settings.impactOptions.length
    ? state.settings.impactOptions
    : ["Single user", "Team blocked", "Business critical"];
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function fillSelect(select, values) {
  select.innerHTML = values
    .map((value) => {
      const pair = Array.isArray(value) ? value : [value, value === "all" ? "All" : value];
      return `<option value="${escapeAttr(pair[0])}">${escapeHtml(pair[1])}</option>`;
    })
    .join("");
}
function optionList(values, selected) {
  return values.map((value) => `<option ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}
function attachmentList(attachments = []) {
  if (!attachments.length) return `<p class="muted">No attachments.</p>`;
  return `<div class="attachment-list">${attachments.map((file) => `<a href="${escapeAttr(file.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.originalName)}</a>`).join("")}</div>`;
}
function countBy(items, field) {
  return items.reduce((counts, item) => {
    const key = item[field] || "Unassigned";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}
function keywordCounts(tickets) {
  const stop = new Set(["the", "and", "for", "with", "this", "that", "from", "ticket", "issue", "cannot"]);
  return tickets.reduce((counts, ticket) => {
    `${ticket.title} ${ticket.description}`.toLowerCase().match(/[a-z0-9]{4,}/g)?.forEach((word) => {
      if (!stop.has(word)) counts[word] = (counts[word] || 0) + 1;
    });
    return counts;
  }, {});
}
function barList(title, counts) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = Math.max(...rows.map((row) => row[1]), 1);
  return `<h3>${title}</h3><div class="bar-list">${rows.length ? rows.map(([label, value]) => `<div class="bar-row"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((value / max) * 100)}%"></div></div><strong>${value}</strong></div>`).join("") : `<p class="muted">No data yet.</p>`}</div>`;
}
function setText(selector, value) { document.querySelector(selector).textContent = value; }
function setNotice(selector, text, type) {
  const element = document.querySelector(selector);
  if (!element) return;
  element.className = `notice ${type}`;
  element.textContent = text;
}
function compact(value) { return String(value).replaceAll(" ", ""); }
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function escapeAttr(value) { return escapeHtml(value); }
function formatDateTime(value) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
