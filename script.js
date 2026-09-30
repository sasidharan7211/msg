const API_URL = "https://script.google.com/macros/s/AKfycby8LQYc8QBQN60Lwk362H4Uq6yNSSl5FQScVulxtOXTZqf7aEBBdz3QJhzEI4Chr8Qp/exec";
const POLL_OPEN = 2500; // while a chat is open
const POLL_IDLE = 5000; // chat list only
const MAX_SHOWN = 300;
const $ = id => document.getElementById(id);
let me = null, db = null, activeUser = null, searchTimer = null;
let currentMessages = [], pending = [], lastHtml = "", lastJson = "", lastRecentHtml = "", chatLoaded = false;
let syncSeq = 0, appliedSeq = 0, sendQueue = Promise.resolve(), pollGen = 0, pollTimer = null, polling = false, firstSync = true, warned = false;
const deleted = new Set();
/* ---------- helpers ---------- */
const sid = v => String(v ?? "").padStart(5, "0"); // keeps leading zeros if backend returns numbers
const cleanId = v => String(v || "").replace(/\D/g, "").slice(0, 5);
const validId = id => /^\d{5}$/.test(id);
const cleanName = n => String(n || "").trim().slice(0, 30);
const initial = n => cleanName(n).charAt(0).toUpperCase() || "?";
const now = () => new Date().toISOString();
const ts = v => Date.parse(v) || 0;
const escapeHtml = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const clock = v => (!v || isNaN(new Date(v)) ? "" : new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
const daysAgo = v => Math.round((new Date().setHours(0, 0, 0, 0) - new Date(v).setHours(0, 0, 0, 0)) / 864e5);
function formatTime(v) { // chat list: time today, otherwise "Yesterday" / date
  if (!v || isNaN(new Date(v))) return "";
  const days = daysAgo(v);
  return days <= 0 ? clock(v) : days === 1 ? "Yesterday" : new Date(v).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}
function dayLabel(v) {
  if (!v || isNaN(new Date(v))) return "";
  const days = daysAgo(v);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : new Date(v).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
function encodeMessage(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeMessage(encoded) {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
  } catch {
    return "";
  }
}
function setText(id, text) { $(id).textContent = text; }
// 0 none, 1 sending, 2 sent, 3 delivered, 4 seen
const tickHtml = st => st === 1 ? '<span class="tick">🕓</span>' : st === 2 ? '<span class="tick">✓</span>' : st === 3 ? '<span class="tick">✓✓</span>' : st === 4 ? '<span class="tick seen">✓✓</span>' : "";
const stateOf = m => m.senderId !== me.id ? 0 : m.seen ? 4 : m.delivered ? 3 : m.sent === false ? 1 : 2;
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start();
    o.stop(t + 0.25);
  } catch {}
}
/* ---------- toast + dialog ---------- */
let toastTimer = null, dialogHandler = null;
function toast(text) {
  setText("toast", text);
  $("toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 3500);
}
// onOk(value) may be async; return an error string to keep the dialog open and show it
function dialog(text, { password = false, okText = "OK", onOk } = {}) {
  setText("dialogText", text);
  setText("dialogError", "");
  setText("dialogOk", okText);
  $("dialogInput").value = "";
  $("dialogInput").classList.toggle("hidden", !password);
  $("dialog").classList.remove("hidden");
  dialogHandler = onOk;
  (password ? $("dialogInput") : $("dialogOk")).focus();
}
function closeDialog() {
  $("dialog").classList.add("hidden");
  dialogHandler = null;
}
async function submitDialog() {
  if (!dialogHandler) return;
  $("dialogOk").disabled = true;
  try {
    const error = await dialogHandler($("dialogInput").value);
    if (error) setText("dialogError", error);
    else closeDialog();
  } catch (e) {
    setText("dialogError", e.message);
  } finally {
    $("dialogOk").disabled = false;
  }
}
$("dialogOk").onclick = submitDialog;
$("dialogCancel").onclick = closeDialog;
$("dialogInput").addEventListener("keydown", e => { if (e.key === "Enter") submitDialog(); });
$("dialog").onclick = e => { if (e.target.id === "dialog") closeDialog(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDialog(); });
/* ---------- API (with timeout, so one hung request can never freeze the app) ---------- */
async function api(action, data = {}, timeout = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let result;
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, token: me?.token, ...data }),
      signal: controller.signal
    });
    result = await response.json();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Server is slow. Please try again." : "Cannot reach the server. Check your internet.");
  } finally {
    clearTimeout(timer);
  }
  if (!result.success) {
    if (result.code === "AUTH" && me) logout("Session expired. Please log in again.");
    throw new Error(result.message || "Something went wrong");
  }
  return result;
}
/* ---------- storage ----------
   Everything for one account lives in ONE localStorage key and in ONE in-memory object (db).
   Screens read from memory (fast); writes are batched (max one write per 0.4 s).
   Every localStorage call is wrapped, so a full/blocked storage can never break the app. */
const DB_VERSION = 2;
const dbKey = id => `miniChat:v${DB_VERSION}:${id}`;
let saveTimer = null;
function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function storageRemove(k) { try { localStorage.removeItem(k); } catch {} }
function loadDb(id) {
  try { // remove data of the old storage format
    Object.keys(localStorage).filter(k => k.startsWith(`miniChat_${id}`)).forEach(k => localStorage.removeItem(k));
  } catch {}
  let data = null;
  try { data = JSON.parse(storageGet(dbKey(id))); } catch {}
  data = data && typeof data === "object" ? data : {};
  return {
    recent: Array.isArray(data.recent) ? data.recent : [],
    unread: data.unread && typeof data.unread === "object" ? data.unread : {},
    hidden: data.hidden && typeof data.hidden === "object" ? data.hidden : {},
    chats: data.chats && typeof data.chats === "object" ? data.chats : {},
    cleared: typeof data.cleared === "string" ? data.cleared : ""
  };
}
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDb, 400);
}
function flushDb() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!db || !me) return;
  const keep = new Set([...db.recent.slice(0, 10).map(u => u.id), activeUser?.id]); // cache only recent chats, last 100 messages each
  const chats = {};
  Object.keys(db.chats).forEach(id => { if (keep.has(id)) chats[id] = db.chats[id].slice(-100); });
  db.chats = chats;
  const text = JSON.stringify(db);
  if (!storageSet(dbKey(me.id), text)) { // storage full: drop the message cache and try again
    db.chats = {};
    storageSet(dbKey(me.id), JSON.stringify(db));
  }
}
window.addEventListener("pagehide", flushDb);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushDb(); });
const hiddenOf = id => db.hidden[id] || [];
function clearUnread(id) {
  if (!db.unread[id]) return;
  delete db.unread[id];
  saveDb();
}
const totalUnread = () => Object.values(db.unread).reduce((a, b) => a + (Number(b) || 0), 0);
function upsertRecent(user, patch = {}) {
  const item = db.recent.find(u => u.id === user.id);
  if (item) Object.assign(item, { name: user.name }, patch);
  else db.recent.push({ id: user.id, name: user.name, lastTime: now(), preview: "", st: 0, ...patch });
  db.recent.sort((a, b) => ts(b.lastTime) - ts(a.lastTime)); // newest message on top
  db.recent.length = Math.min(db.recent.length, 30);
  saveDb();
}
/* ---------- session ---------- */
function enterApp(user) {
  me = user;
  db = loadDb(me.id);
  storageSet("miniChatUser", JSON.stringify(me));
  openApp();
}
function resetSession() {
  flushDb();
  pollGen++; // stops the polling loop
  clearTimeout(pollTimer);
  me = null;
  db = null;
  activeUser = null;
  currentMessages = [];
  pending = [];
  deleted.clear();
  lastHtml = lastJson = lastRecentHtml = "";
  firstSync = true;
  document.title = "Mini Chat";
  storageRemove("miniChatUser");
}
function logout(message) {
  resetSession();
  $("chatScreen").classList.add("hidden");
  $("authScreen").classList.remove("hidden");
  $("loginPassword").value = "";
  showAuth(false);
  if (message) toast(message);
}
$("logoutBtn").onclick = () => logout();
/* ---------- auth UI ---------- */
function showAuth(signup) {
  $("loginBox").classList.toggle("hidden", signup);
  $("signupBox").classList.toggle("hidden", !signup);
  setText("loginMessage", "");
  setText("signupMessage", "");
}
$("showSignup").onclick = () => showAuth(true);
$("showLogin").onclick = () => showAuth(false);
function onEnter(ids, fn) {
  ids.forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") fn(); }));
}
async function startSession(id, password) {
  const result = await api("login", { id, password });
  enterApp({ id: sid(result.user.id), name: result.user.name, token: result.token });
}
async function signup() {
  const name = cleanName($("signupName").value);
  const id = cleanId($("signupId").value);
  const password = $("signupPassword").value;
  const error = !name ? "Enter your name."
    : !validId(id) ? "ID must contain exactly 5 digits."
    : password.length < 4 ? "Password must be at least 4 characters."
    : password !== $("signupPasswordConfirm").value ? "Passwords do not match." : "";
  setText("signupMessage", error);
  if (error) return;
  try {
    $("signupBtn").disabled = true;
    await api("signup", { id, name, password });
    await startSession(id, password); // go straight into the app
    ["signupName", "signupId", "signupPassword", "signupPasswordConfirm"].forEach(i => $(i).value = "");
    showAuth(false);
  } catch (e) {
    setText("signupMessage", e.message);
  } finally {
    $("signupBtn").disabled = false;
  }
}
$("signupBtn").onclick = signup;
onEnter(["signupName", "signupId", "signupPassword", "signupPasswordConfirm"], signup);
async function login() {
  const id = cleanId($("loginId").value);
  const password = $("loginPassword").value;
  const error = !validId(id) ? "Enter your 5-digit ID." : !password ? "Enter your password." : "";
  setText("loginMessage", error);
  if (error) return;
  try {
    $("loginBtn").disabled = true;
    await startSession(id, password);
  } catch (e) {
    setText("loginMessage", e.message);
  } finally {
    $("loginBtn").disabled = false;
  }
}
$("loginBtn").onclick = login;
onEnter(["loginId", "loginPassword"], login);
function openApp() {
  $("authScreen").classList.add("hidden");
  $("chatScreen").classList.remove("hidden");
  setText("myName", me.name);
  setText("myId", me.id);
  setText("myAvatar", initial(me.name));
  showEmptyChat();
  renderRecent();
  startPolling();
}
/* ---------- search ---------- */
$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const id = cleanId($("searchInput").value);
  $("searchInput").value = id;
  $("searchResults").innerHTML = "";
  if (validId(id)) searchTimer = setTimeout(() => searchUser(id), 250);
});
$("clearSearch").onclick = () => {
  $("searchInput").value = "";
  $("searchResults").innerHTML = "";
  $("searchInput").focus();
};
async function searchUser(id) {
  const box = $("searchResults");
  const info = text => box.innerHTML = `<div class="emptyRecent">${escapeHtml(text)}</div>`;
  try {
    const { user } = await api("searchUser", { id, userId: me.id });
    if (!me || $("searchInput").value !== id) return; // input changed while waiting
    if (!user) return info("User not found");
    const found = { id: sid(user.id), name: user.name };
    if (found.id === me.id) return info("This is your ID");
    box.innerHTML = `<div class="searchUser">
      <div class="avatar">${escapeHtml(initial(found.name))}</div>
      <div class="searchInfo"><div class="searchName">${escapeHtml(found.name)}</div><div class="searchId">${escapeHtml(found.id)}</div></div>
    </div>`;
    box.firstElementChild.onclick = () => {
      openChat(found);
      box.innerHTML = "";
      $("searchInput").value = "";
    };
  } catch (e) {
    info(e.message);
  }
}
/* ---------- recent chats (newest on top, unread badge like WhatsApp) ---------- */
function renderRecent() {
  const html = db.recent.map(u => {
    const count = db.unread[u.id] || 0;
    const cls = count > 0 ? " new" : "";
    return `<div class="recentChat" data-id="${escapeHtml(u.id)}">
      <div class="avatar">${escapeHtml(initial(u.name))}</div>
      <div class="recentInfo">
        <div class="recentTop"><div class="recentName">${escapeHtml(u.name)}</div><div class="recentTime${cls}">${formatTime(u.lastTime)}</div></div>
        <div class="recentBottom"><div class="recentPreview${cls}">${tickHtml(u.st)}${escapeHtml(u.preview || "Open chat")}</div>${count > 0 ? `<div class="unread">${count > 99 ? "99+" : count}</div>` : ""}</div>
      </div>
    </div>`;
  }).join("");
  $("noRecent").classList.toggle("hidden", db.recent.length > 0);
  const total = totalUnread();
  document.title = total > 0 ? `(${total}) Mini Chat` : "Mini Chat";
  if (html === lastRecentHtml) return; // nothing changed
  lastRecentHtml = html;
  $("chatList").innerHTML = html;
}
$("chatList").onclick = e => {
  const row = e.target.closest(".recentChat");
  const user = row && db.recent.find(u => u.id === row.dataset.id);
  if (user) openChat(user);
};
$("clearRecent").onclick = () => dialog("Clear recent chats from this device?", {
  okText: "Clear",
  onOk: () => {
    db.cleared = now(); // stops the next sync from re-adding old chats
    db.recent = [];
    db.unread = {};
    db.chats = {};
    saveDb();
    renderRecent();
  }
});
function applyChats(chats) {
  const cleared = ts(db.cleared);
  let incoming = false;
  chats.forEach(chat => {
    if (ts(chat.time) <= cleared) return;
    const id = sid(chat.id);
    if (pending.some(p => p.receiverId === id)) return; // our own message is newer than the server copy
    const st = sid(chat.senderId) === me.id ? (chat.seen ? 4 : chat.delivered ? 3 : 2) : 0;
    upsertRecent({ id, name: chat.name }, { lastTime: chat.time, preview: decodeMessage(chat.content) || "Message", st });
    const count = id === activeUser?.id ? 0 : Number(chat.unread || 0);
    if (count > (db.unread[id] || 0)) incoming = true;
    if (count) db.unread[id] = count;
    else delete db.unread[id];
  });
  const listed = new Set(chats.map(c => sid(c.id)));
  db.recent = db.recent.filter(u => {
    if (listed.has(u.id) || pending.some(p => p.receiverId === u.id)) return true;
    delete db.chats[u.id]; // gone from the server, so gone from this device
    delete db.hidden[u.id];
    delete db.unread[u.id];
    return false;
  });
  saveDb();
  renderRecent();
  if (incoming && !firstSync) beep();
  firstSync = false;
}
/* ---------- open / close chat ---------- */
function openChat(user) {
  activeUser = { id: user.id, name: user.name };
  clearUnread(user.id);
  renderRecent();
  $("chatScreen").classList.add("chatOpen");
  $("emptyChat").classList.add("hidden");
  $("activeChat").classList.remove("hidden");
  setText("chatUserName", user.name);
  setText("chatUserId", user.id);
  setText("chatAvatar", initial(user.name));
  lastHtml = "";
  chatLoaded = false;
  currentMessages = db.chats[user.id] || [];
  lastJson = JSON.stringify(currentMessages);
  renderMessages(true); // cached messages show instantly
  sync(true).catch(syncError);
  if (matchMedia("(pointer: fine)").matches) setTimeout(() => $("messageInput").focus(), 100); // mouse devices only, so phones do not open the keypad
}
function showEmptyChat() {
  activeUser = null;
  $("chatScreen").classList.remove("chatOpen");
  $("activeChat").classList.add("hidden");
  $("emptyChat").classList.remove("hidden");
}
$("backBtn").onclick = showEmptyChat;
/* ---------- sync: ONE request gets recent chats + open chat ---------- */
async function sync(scroll = false) {
  if (!me) return;
  const other = activeUser?.id || "";
  const seq = ++syncSeq;
  const result = await api("sync", { userId: me.id, otherId: other });
  if (!me || seq < appliedSeq) return; // logged out, or an older reply arrived late
  appliedSeq = seq;
  pending = pending.filter(p => !(p.sent && seq > p.sentSeq)); // this sync started after the send finished, so the server copy is in the reply
  applyChats(result.chats || []);
  if (other && activeUser?.id === other) applyMessages(other, result.messages || [], scroll);
}
function applyMessages(other, raw, scroll) {
  const messages = raw
    .map(m => ({ ...m, senderId: sid(m.senderId), receiverId: sid(m.receiverId) }))
    .filter(m => !deleted.has(m.messageId));
  const json = JSON.stringify(messages);
  if (json !== lastJson) {
    const received = list => list.filter(m => m.senderId !== me.id).length;
    if (chatLoaded && received(messages) > received(currentMessages)) beep();
    lastJson = json;
    currentMessages = messages;
    db.chats[other] = messages;
    if (messages.length < 300 && db.hidden[other]) { // full history received: forget hidden ids of deleted messages
      const ids = new Set(messages.map(m => m.messageId));
      db.hidden[other] = db.hidden[other].filter(id => ids.has(id));
      if (!db.hidden[other].length) delete db.hidden[other];
    }
    const shown = view().pop();
    if (shown) upsertRecent(activeUser, { lastTime: shown.time, preview: decodeMessage(shown.content) || "Message", st: stateOf(shown) });
    clearUnread(other);
    saveDb();
    renderRecent();
  }
  chatLoaded = true;
  renderMessages(scroll);
}
/* ---------- messages ---------- */
// server messages + our own messages that the server has not returned yet
function view() {
  const ids = new Set(currentMessages.map(m => m.messageId));
  return [...currentMessages, ...pending.filter(p => p.receiverId === activeUser.id && !ids.has(p.messageId))];
}
function renderMessages(scroll = false) {
  if (!activeUser) return;
  const box = $("messages");
  const hidden = hiddenOf(activeUser.id);
  let day = "";
  const html = view().filter(m => !(m.receiverId === me.id && hidden.includes(m.messageId))).slice(-MAX_SHOWN).map(m => {
    const label = dayLabel(m.time);
    const sep = label !== day ? `<div class="dateSep"><span>${escapeHtml(label)}</span></div>` : "";
    day = label;
    return `${sep}<div class="messageRow ${m.senderId === me.id ? "mine" : ""}" data-id="${escapeHtml(m.messageId)}">
      <div class="messageBubble" title="Click to delete">
        <div class="messageText">${escapeHtml(decodeMessage(m.content))}</div>
        <div class="messageMeta">${clock(m.time)}${tickHtml(stateOf(m))}</div>
      </div>
    </div>`;
  }).join("");
  if (html === lastHtml && !scroll) return; // nothing changed, keep DOM and scroll position
  lastHtml = html;
  const top = box.scrollTop;
  const nearBottom = box.scrollHeight - top - box.clientHeight < 80;
  box.innerHTML = html;
  box.scrollTop = scroll || nearBottom ? box.scrollHeight : top;
}
$("messages").onclick = e => {
  const bubble = e.target.closest(".messageBubble");
  if (!bubble || String(getSelection())) return; // ignore when the user is selecting text to copy
  const id = bubble.closest(".messageRow").dataset.id;
  const message = view().find(m => String(m.messageId) === id);
  if (message && message.sent !== false) deleteMessage(message); // unsent messages cannot be deleted yet
};
function deleteMessage(message) {
  const chatId = activeUser.id;
  if (message.senderId === me.id) {
    return dialog("Delete this message for everyone?", {
      okText: "Delete",
      onOk: () => {
        deleted.add(message.messageId);
        currentMessages = currentMessages.filter(m => m.messageId !== message.messageId);
        pending = pending.filter(p => p.messageId !== message.messageId);
        if (db.chats[chatId]) db.chats[chatId] = currentMessages;
        lastJson = "";
        saveDb();
        if (activeUser?.id === chatId) renderMessages(); // disappears instantly, server catches up in the background
        api("deleteMessage", { userId: me.id, messageId: message.messageId }).catch(e => {
          deleted.delete(message.messageId);
          toast(e.message);
        });
      }
    });
  }
  dialog("Delete this message for you?", {
    okText: "Delete",
    onOk: () => {
      db.hidden[chatId] = [...hiddenOf(chatId).filter(id => id !== message.messageId), message.messageId].slice(-500);
      saveDb();
      if (activeUser?.id === chatId) renderMessages();
    }
  });
}
/* ---------- send ---------- */
const input = $("messageInput");
function resizeInput() {
  input.style.height = "40px";
  input.style.height = Math.min(input.scrollHeight, 130) + "px";
}
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$("sendBtn").onclick = sendMessage;
function sendMessage() {
  const text = input.value.trim();
  if (!activeUser || !text) return;
  const target = activeUser;
  const content = encodeMessage(text);
  const msg = { messageId: "temp_" + Date.now() + Math.random().toString(36).slice(2, 6), senderId: me.id, receiverId: target.id, time: now(), content, sent: false };
  input.value = "";
  resizeInput();
  pending.push(msg); // shown at once with a clock, becomes ✓ when the server confirms
  renderMessages(true);
  upsertRecent(target, { lastTime: msg.time, preview: text, st: 1 });
  renderRecent();
  // messages go out one after another so their order never gets mixed up
  sendQueue = sendQueue.then(async () => {
    if (!me) return;
    try {
      const result = await api("sendMessage", { senderId: msg.senderId, receiverId: target.id, content }, 45000);
      msg.messageId = result.messageId; // real id: the next poll replaces this copy with the server one
      msg.time = result.time || msg.time;
      msg.sent = true;
      msg.sentSeq = syncSeq;
      upsertRecent(target, { lastTime: msg.time, st: 2 });
    } catch (e) {
      if (!me) return;
      pending = pending.filter(p => p !== msg);
      toast(e.message || "Message not sent");
      if (!input.value) { input.value = text; resizeInput(); }
    }
    if (me) {
      renderRecent();
      renderMessages();
    }
  });
}
/* ---------- delete account ---------- */
$("deleteAccountBtn").onclick = () => dialog("Enter your password to permanently delete your account and all your messages.", {
  password: true,
  okText: "Delete account",
  onOk: async password => {
    if (!password) return "Enter your password.";
    try {
      await api("deleteAccount", { userId: me.id, password }); // server verifies the password
    } catch (e) {
      return e.message;
    }
    pollGen++;
    storageRemove(dbKey(me.id));
    storageRemove("miniChatUser");
    me = null; // nothing may be saved again
    db = null;
    toast("Account deleted.");
    setTimeout(() => location.reload(), 1200);
  }
});
/* ---------- polling (waits for the previous request, faster while a chat is open) ---------- */
function syncError(e) {
  console.log(e);
  if (/unknown action/i.test(e.message) && !warned) {
    warned = true;
    toast("Backend is outdated: paste the new Code.gs and deploy a NEW version.");
  }
}
async function poll() {
  if (!me || polling) return;
  polling = true;
  try { await sync(); } catch (e) { syncError(e); } finally { polling = false; }
}
function startPolling() {
  const gen = ++pollGen;
  clearTimeout(pollTimer);
  (async function loop() {
    if (gen !== pollGen || !me) return;
    if (!document.hidden) await poll();
    if (gen === pollGen) pollTimer = setTimeout(loop, activeUser ? POLL_OPEN : POLL_IDLE);
  })();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
/* ---------- restore login ---------- */
(function restoreLogin() {
  try {
    const saved = JSON.parse(storageGet("miniChatUser"));
    if (saved && validId(saved.id) && saved.name && saved.token) enterApp(saved);
    else storageRemove("miniChatUser");
  } catch {
    storageRemove("miniChatUser");
  }
})();