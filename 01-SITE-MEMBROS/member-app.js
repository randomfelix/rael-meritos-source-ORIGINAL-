import "./firebase-config.js";
import { auth, db, syntheticEmail, normalizeUsername } from "./firebase.js";
import { call } from "./firebase-operations.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword, EmailAuthProvider, reauthenticateWithCredential, deleteUser } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { ref, get, set, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const mode = document.body.dataset.mode || "site";
const isApp = mode === "app";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const safeImage = value => /^(https:\/\/|data:image\/(?:jpeg|png|webp);base64,)/i.test(String(value || "")) ? esc(value) : "./avatar-default.svg";
const formatDate = value => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(Number(value))) : "Data indisponível";
const number = value => new Intl.NumberFormat("pt-BR").format(Number(value || 0));

const RELEASE_NOTES = `
  <p>Chegou a v1.1.2 do R.A.E.L. Méritos.</p>
  <ul class="release-list">
    <li>Agora dá para limpar notificações, movimentações e dados das análises sem alterar o saldo da conta.</li>
    <li>Foto de perfil e banner podem ser escolhidos direto da galeria do celular ou dos arquivos do computador.</li>
    <li>A loja aceita imagem nos produtos; no painel também dá para editar e excluir itens.</li>
    <li>Seus relatos para a administração podem ser editados ou apagados. O painel também ganhou a limpeza de solicitações respondidas.</li>
    <li>Os pop-ups têm animações mais suaves e uma cor que você pode personalizar.</li>
    <li>Enquanto o cadastro aguarda aprovação, você já pode deixar o perfil com a sua cara. Se for aprovado, as mudanças ficam; se for suspenso, o rascunho é descartado.</li>
    <li>Também ajustamos alguns detalhes da navegação e da loja para facilitar o uso no celular.</li>
  </ul>`;

let authMode = "login";
let authBusy = false;
let currentUser = null;
let account = null;
let profile = null;
let notifications = [];
let publicProfiles = {};
let transactions = [];
let stats = { earned: 0, lost: 0, views: 0 };
let tickets = {};
let shopItems = {};
let activeView = "home";
let unsubscribe = [];
let notificationsInitialized = false;
let knownNotificationIds = new Set();
let directoryQuery = "";
let lastDirectorySnapshot = {};

const authPanel = $("#authPanel");
const dashboard = $("#dashboard");
const pendingPanel = $("#pendingPanel");
const bannedPanel = $("#bannedPanel");
const modalBackdrop = $("#modalBackdrop");
const modalContent = $("#modalContent");
const modalFooter = $("#modalFooter");

function showOnly(element) {
  closeNavigation();
  [authPanel, dashboard, pendingPanel, bannedPanel].forEach(item => item?.classList.add("hidden"));
  element?.classList.remove("hidden");
  document.body.classList.toggle("member-logged-in", element === dashboard);
}

function toast(message, title = "R.A.E.L.", error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.style.setProperty("--toast-accent", localStorage.getItem("rael-popup-color") || "var(--accent)");
  element.innerHTML = `<strong>${esc(title)}</strong>${esc(message)}`;
  $("#toastRegion").append(element);
  window.setTimeout(() => {
    element.classList.add("toast-leaving");
    window.setTimeout(() => element.remove(), 260);
  }, 3900);
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message || "Ocorreu um erro. Tente novamente.";
}

function errorMessage(error) {
  const code = error?.code || "";
  const message = error?.message || "";
  if (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password") || code.includes("auth/user-not-found")) return "Usuário ou senha incorretos.";
  if (code.includes("auth/email-already-in-use")) return "Este nome já tem uma conta. Tente entrar.";
  if (code.includes("auth/weak-password")) return "A senha precisa ter pelo menos 8 caracteres.";
  if (code.includes("auth/too-many-requests")) return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  if (message.includes("already-exists")) return "Este nome de usuário já está em uso.";
  return message.replace(/^Firebase: /, "") || "Ocorreu um erro. Tente novamente.";
}

let modalCloseTimer = null;
function closeModal() {
  if (modalCloseTimer) window.clearTimeout(modalCloseTimer);
  modalBackdrop.classList.remove("is-closing");
  modalBackdrop.classList.add("is-closing");
  modalCloseTimer = window.setTimeout(() => {
    if (!modalBackdrop.classList.contains("is-closing")) return;
    modalBackdrop.classList.add("hidden");
    modalBackdrop.classList.remove("is-closing");
    modalContent.innerHTML = "";
    modalFooter.innerHTML = "";
    modalCloseTimer = null;
  }, 190);
}

function openModal(title, content, footer = "", kicker = "R.A.E.L.") {
  if (modalCloseTimer) window.clearTimeout(modalCloseTimer);
  modalCloseTimer = null;
  modalBackdrop.classList.remove("is-closing");
  $("#modalTitle").textContent = title;
  $("#modalKicker").textContent = kicker;
  modalContent.innerHTML = content;
  modalFooter.innerHTML = footer;
  modalBackdrop.classList.remove("hidden");
  $("#modalClose").focus();
}

$("#modalClose")?.addEventListener("click", closeModal);
modalBackdrop?.addEventListener("click", event => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") { closeModal(); closeNavigation(); } });

function setAuthMode(nextMode) {
  authMode = nextMode;
  $$("[data-auth-mode]").forEach(button => button.classList.toggle("selected", button.dataset.authMode === nextMode));
  const registering = nextMode === "register";
  $("#authTitle").textContent = registering ? "Crie sua conta" : "Entre na sua conta";
  $("#authDescription").textContent = registering ? "Use exatamente o nome pelo qual a comunidade conhece você." : "Acompanhe seus méritos e as novidades da comunidade.";
  $("#usernameWarning").classList.toggle("hidden", !registering);
  $("#confirmPasswordLabel").classList.toggle("hidden", !registering);
  $("#confirmPasswordInput").required = registering;
  $("#passwordInput").autocomplete = registering ? "new-password" : "current-password";
  $("#authSubmit").textContent = registering ? "Enviar cadastro" : "Entrar";
  showError($("#authError"), "");
}
$$("[data-auth-mode]").forEach(button => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));

async function loadAccount(user) {
  currentUser = user;
  cleanupListeners();
  notificationsInitialized = false;
  knownNotificationIds = new Set();
  if (!user) {
    account = null; profile = null;
    $("#topActions").classList.add("hidden");
    $("#siteFooter").classList.add("hidden");
    showOnly(authPanel);
    return;
  }
  try {
    const snap = await get(ref(db, `accounts/${user.uid}`));
    if (!snap.exists()) {
      await signOut(auth);
      showOnly(authPanel);
      toast("A conta ainda não tem um cadastro no sistema. Tente criar a conta novamente.", "Cadastro incompleto", true);
      return;
    }
    account = snap.val();
    if (account.status === "pending") {
      showOnly(pendingPanel);
      await loadPendingProfileDraft(user.uid);
      const pendingRef = ref(db, `accounts/${user.uid}`);
      const stopPending = onValue(pendingRef, snap => {
        const live = snap.val();
        if (!live) return;
        if (live.status === "approved") { stopPending(); loadAccount(user); }
        else if (live.status === "banned") { stopPending(); showOnly(bannedPanel); }
      });
      unsubscribe.push(stopPending);
      return;
    }
    if (account.status === "banned") { showOnly(bannedPanel); return; }
    if (account.status !== "approved") { showOnly(pendingPanel); return; }
    showOnly(dashboard);
    $("#topActions").classList.remove("hidden");
    $("#siteFooter").classList.remove("hidden");
    $("#footerVersion").textContent = "v1.1.2";
    const profileSnap = await get(ref(db, `publicProfiles/${user.uid}`));
    profile = profileSnap.val() || { username: account.username, bio: "", photoURL: "", bannerURL: "" };
    $("#welcomeTitle").textContent = `Olá, ${profile.username || account.username}`;
    $("#miniUsername").textContent = profile.username || account.username;
    $("#miniAvatar").src = safeImage(profile.photoURL);
    attachListeners(user.uid);
    renderScreen();
    if (isApp && localStorage.getItem("rael-release-seen") !== "v1.1.2") {
      window.setTimeout(() => { if (account?.status === "approved" && localStorage.getItem("rael-release-seen") !== "v1.1.2") showReleaseNotes(true); }, 450);
    }
  } catch (error) {
    toast(errorMessage(error), "Não foi possível abrir a conta", true);
  }
}

function cleanupListeners() {
  unsubscribe.forEach(fn => { try { fn(); } catch {} });
  unsubscribe = [];
}

function attachListeners(uid) {
  const accountRef = ref(db, `accounts/${uid}`);
  const profileRef = ref(db, `publicProfiles/${uid}`);
  const notifRef = ref(db, `notifications/${uid}`);
  const txnRef = ref(db, `transactions/${uid}`);
  const statsRef = ref(db, `stats/${uid}`);
  const ticketRef = ref(db, `tickets/${uid}`);
  const shopRef = ref(db, "shopItems");
  const addListener = (pathRef, callback) => {
    const stop = onValue(pathRef, snap => callback(snap.val()));
    unsubscribe.push(stop);
  };
  addListener(accountRef, value => {
    if (!value) return;
    account = value;
    if (value.status === "banned") { cleanupListeners(); showOnly(bannedPanel); return; }
    if (value.status === "pending") { cleanupListeners(); showOnly(pendingPanel); return; }
    if (value.status !== "approved") return;
    if ($("#welcomeTitle")) $("#welcomeTitle").textContent = `Olá, ${profile?.username || value.username}`;
    if (activeView === "home") renderScreen();
  });
  addListener(profileRef, value => {
    profile = value || profile;
    if (profile) {
      $("#welcomeTitle").textContent = `Olá, ${profile.username || account.username}`;
      $("#miniUsername").textContent = profile.username || account.username;
      $("#miniAvatar").src = safeImage(profile.photoURL);
      if (activeView === "home") renderScreen();
    }
  });
  addListener(notifRef, value => {
    const nextNotifications = Object.entries(value || {}).map(([id, item]) => ({ id, ...item })).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (notificationsInitialized) {
      const newest = nextNotifications.filter(item => !knownNotificationIds.has(item.id) && !item.read).sort((a,b) => Number(a.createdAt || 0)-Number(b.createdAt || 0));
      newest.forEach(item => toast(item.body || "Você recebeu uma notificação nova.", item.title || "R.A.E.L. Méritos"));
    }
    knownNotificationIds = new Set(nextNotifications.map(item => item.id));
    notifications = nextNotifications;
    notificationsInitialized = true;
    const unread = notifications.filter(item => !item.read).length;
    const dot = $("#notificationDot");
    dot.classList.toggle("hidden", !unread);
    dot.title = unread ? `${unread} notificação(ões) não lida(s)` : "Nenhuma notificação nova";
    if (activeView === "other") { /* mantém estado do ponto sem re-renderizar preferências */ }
  });
  addListener(txnRef, value => {
    transactions = Object.entries(value || {}).map(([id, item]) => ({ id, ...item })).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (activeView === "payments" || activeView === "home") renderScreen();
  });
  addListener(statsRef, value => {
    stats = value || { earned: 0, lost: 0, views: 0 };
    if (activeView === "analytics") renderScreen();
  });
  addListener(ticketRef, value => {
    tickets = value || {};
    if (activeView === "contact") renderScreen();
  });
  addListener(shopRef, value => {
    shopItems = value || {};
    if (activeView === "payments" || activeView === "store") renderScreen();
  });
}

$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const username = $("#usernameInput").value.trim();
  const password = $("#passwordInput").value;
  const confirmPassword = $("#confirmPasswordInput").value;
  const error = $("#authError");
  showError(error, "");
  if (!/^[A-Za-z0-9._-]{3,24}$/.test(username)) { showError(error, "Use de 3 a 24 caracteres: letras sem acento, números, ponto, hífen ou sublinhado."); return; }
  if (authMode === "register" && password !== confirmPassword) { showError(error, "As senhas não são iguais."); return; }
  if (password.length < 8) { showError(error, "A senha precisa ter pelo menos 8 caracteres."); return; }
  authBusy = true;
  const button = $("#authSubmit");
  button.disabled = true;
  button.textContent = authMode === "register" ? "Enviando cadastro…" : "Entrando…";
  let createdAuthUser = false;
  let memberRegistrationCompleted = false;
  try {
    let credential;
    if (authMode === "register") {
      credential = await createUserWithEmailAndPassword(auth, syntheticEmail(normalizeUsername(username)), password);
      createdAuthUser = true;
      await call("registerMember")({ username });
      memberRegistrationCompleted = true;
      toast("Cadastro enviado. Seu acesso depende da aprovação de um administrador.", "Cadastro recebido");
    } else {
      credential = await signInWithEmailAndPassword(auth, syntheticEmail(normalizeUsername(username)), password);
    }
    await loadAccount(credential.user);
  } catch (err) {
    showError(error, errorMessage(err));
    if (authMode === "register" && createdAuthUser && !memberRegistrationCompleted && auth.currentUser) {
      // Não deixe uma conta de autenticação vazia ocupando o nome caso o cadastro seja recusado.
      try {
        const ownRecord = await get(ref(db, `accounts/${auth.currentUser.uid}`));
        if (!ownRecord.exists()) await deleteUser(auth.currentUser);
      } catch {}
      try { await signOut(auth); } catch {}
    }
  } finally {
    authBusy = false;
    button.disabled = false;
    button.textContent = authMode === "register" ? "Enviar cadastro" : "Entrar";
  }
});

$("#pendingLogout")?.addEventListener("click", () => signOut(auth));
$("#bannedLogout")?.addEventListener("click", () => signOut(auth));

function emptyState(title, message, icon = "box") {
  const icons = {
    box: '<svg viewBox="0 0 24 24"><path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>',
    people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c.4-4 2.3-6 6-6s5.6 2 6 6"/></svg>'
  };
  return `<div class="empty-state"><div class="empty-mark">${icons[icon] || icons.box}</div><strong>${esc(title)}</strong><br>${esc(message)}</div>`;
}

function recentTransactions(limit = 4) {
  if (!transactions.length) return emptyState("Nenhuma movimentação", "Quando seu saldo mudar, as movimentações aparecerão aqui.");
  return `<div class="list-panel">${transactions.slice(0, limit).map(item => {
    const credit = item.kind === "credit";
    const amount = Number(item.amount || 0);
    return `<div class="list-row"><div class="notification-icon"><svg viewBox="0 0 24 24"><path d="${credit ? "M12 19V5m-6 6 6-6 6 6" : "M12 5v14m-6-6 6 6 6-6"}"/></svg></div><div class="list-row-main"><strong>${esc(item.reason || (credit ? "Méritos recebidos" : "Méritos descontados"))}</strong><small>${esc(formatDate(item.createdAt))}</small></div><div class="row-amount ${credit ? "amount-positive" : "amount-negative"}">${credit ? "+" : "−"}${number(amount)}</div></div>`;
  }).join("")}</div>`;
}

function renderHome() {
  const balance = number(account?.meritos);
  return `<div class="balance-layout">
    <section class="balance-card"><div class="balance-heading">SALDO DISPONÍVEL</div><div class="balance-orb"><strong>${balance}</strong><span>MÉRITOS</span></div><p class="balance-caption">Seu saldo na comunidade R.A.E.L.</p></section>
    <div class="balance-side"><section class="info-card"><h3>Um sistema da comunidade</h3><p>Seus méritos são gerenciados pela administração da R.A.E.L. Qualquer alteração de saldo aparece no histórico e nas notificações.</p></section><div class="mini-stat-row"><div class="mini-stat"><span>Total recebido</span><strong>${number(stats.earned)}</strong></div><div class="mini-stat"><span>Total descontado</span><strong>${number(stats.lost)}</strong></div></div></div>
  </div>
  <div class="quick-actions"><button class="quick-action" data-quick="payments"><span class="quick-icon"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg></span>Ver movimentações</button><button class="quick-action" data-quick="people"><span class="quick-icon"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c.4-4 2.3-6 6-6s5.6 2 6 6M16 5a3 3 0 0 1 0 6M18 15c2 .6 3 2 3 4"/></svg></span>Ver comunidade</button><button class="quick-action" data-quick="contact"><span class="quick-icon"><svg viewBox="0 0 24 24"><path d="M4 4h16v13H9l-5 4zM8 9h8M8 13h5"/></svg></span>Falar com admin</button></div>
  <section style="margin-top:28px"><div class="section-heading"><div><h2>Últimas movimentações</h2><p>Um resumo das alterações na sua conta.</p></div><button class="subtle-link" data-quick="payments">Ver todas</button></div>${recentTransactions(3)}</section>`;
}

function renderPayments() {
  return `<div class="section-heading"><div><h2>Movimentações</h2><p>Créditos, descontos e compras registradas na sua conta.</p></div></div>${recentTransactions(100)}`;
}

function renderStore() {
  // Mostrar o catálogo mesmo quando os itens estão fechados; somente itens ativos podem ser comprados.
  const items = Object.entries(shopItems).map(([id, item]) => ({ id, ...item }))
    .filter(item => Number.isInteger(Number(item.price)) && Number(item.price) > 0)
    .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"pt-BR"));
  const catalog = items.length ? `<div class="shop-grid">${items.map(item => {
    const onSale = item.active === true;
    return `<article class="shop-card">${item.imageURL ? `<img class="shop-card-image" src="${safeImage(item.imageURL)}" alt="Imagem de ${esc(item.name || "item")}" loading="lazy">` : ""}<div class="shop-card-copy"><span class="shop-state ${onSale ? "on-sale" : "closed"}">${onSale ? "À venda" : "Venda fechada"}</span><h3>${esc(item.name || "Item da comunidade")}</h3><p>${esc(item.description || "Item disponibilizado pela administração.")}</p><strong>${number(item.price)} <small>MÉRITOS</small></strong></div><button class="primary-button" data-buy-item="${esc(item.id)}" ${onSale ? "" : "disabled"}>${onSale ? "Comprar" : "Indisponível"}</button></article>`;
  }).join("")}</div>` : emptyState("Catálogo ainda vazio", "Os itens aparecerão aqui quando a administração cadastrar o catálogo no painel.");
  return `<div class="section-heading"><div><h2>Loja de méritos</h2><p>Use seus méritos para comprar itens da comunidade. Itens fechados ficam visíveis, mas não podem ser comprados.</p></div></div>${catalog}<div class="notice-block" style="margin-top:18px"><h3>Como funciona</h3><p>O saldo é descontado quando a compra é confirmada. A administração recebe um comprovante e realiza a entrega na comunidade.</p></div>`;
}

function renderAnalytics() {
  if (!isApp) return `<div class="notice-block"><h3>As análises ainda não estão disponíveis no site</h3><p>Em breve. Desbloqueie o acesso antecipado às análises usando o app, disponível na comunidade do WhatsApp.</p></div>`;
  return `<div class="section-heading"><div><h2>Análises beta</h2><p>Estatísticas da sua conta. Os números atualizam conforme os registros do sistema.</p></div></div><div class="analytics-grid"><article class="analytics-card"><span>Saldo atual de méritos</span><strong class="stat-accent">${number(account?.meritos)}</strong></article><article class="analytics-card"><span>Total de méritos recebidos</span><strong>${number(stats.earned)}</strong></article><article class="analytics-card"><span>Total de méritos perdidos</span><strong>${number(stats.lost)}</strong></article><article class="analytics-card"><span>Visualizações do seu perfil</span><strong>${number(stats.views)}</strong></article></div><div class="notice-block"><h3>Sobre a versão beta</h3><p>As visualizações contam no máximo uma vez por pessoa a cada 24 horas. O total de méritos recebidos inclui o saldo inicial quando concedido pela administração.</p></div>`;
}

function renderContact() {
  const myTickets = Object.entries(tickets).map(([id, item]) => ({ id, ...item })).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const ticketsHTML = myTickets.length ? myTickets.map(ticket => `<article class="ticket-card"><div class="ticket-meta">${esc(formatDate(ticket.createdAt))} · <strong>${esc(ticket.status || "aberto")}</strong></div><p>${esc(ticket.message)}</p>${ticket.reply ? `<div class="ticket-reply"><strong>Resposta da administração</strong><br>${esc(ticket.reply)}</div>` : ""}<div class="ticket-actions"><button class="secondary-button" data-edit-ticket="${esc(ticket.id)}">Editar</button><button class="danger-button" data-delete-ticket="${esc(ticket.id)}">Excluir</button></div></article>`).join("") : emptyState("Nenhum relato enviado", "Se você reportar um problema, poderá acompanhar a resposta por aqui.");
  return `<div class="section-heading"><div><h2>Contato e suporte</h2><p>Encontrou um erro, problema com méritos ou outra questão?</p></div></div><div class="contact-grid"><section class="form-card"><h3>Fale com um administrador</h3><p>Escreva seu relato. Você receberá uma notificação quando houver uma resposta.</p><form id="reportForm"><label>Seu relato<textarea id="reportMessage" class="field-textarea" maxlength="1500" minlength="5" placeholder="Explique o que aconteceu…" required></textarea></label><button type="submit" class="primary-button">Enviar relato</button><p class="form-error" id="reportError"></p></form></section><section><div class="section-heading"><div><h2>Meus relatos</h2><p>Acompanhe o andamento.</p></div></div>${ticketsHTML}</section></div>`;
}

function renderOther() {
  return `<div class="section-heading"><div><h2>Outros</h2><p>Preferências da sua conta e do aplicativo.</p></div></div><div class="other-stack">
    <button class="settings-row" data-setting="theme"><span class="settings-symbol"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z"/></svg></span><span class="settings-copy"><strong>Aparência</strong><small>Escolha tema claro ou escuro.</small></span><span class="arrow">›</span></button>
    <button class="settings-row" data-setting="popup-color"><span class="settings-symbol"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H13a1.5 1.5 0 0 1 0-3h2a4 4 0 0 0 4-4c0-3.3-3.1-6-7-6Z"/><circle cx="7.5" cy="10" r="1"/><circle cx="11" cy="7.5" r="1"/></svg></span><span class="settings-copy"><strong>Cor dos pop-ups</strong><small>Personalize o destaque das notificações.</small></span><span class="arrow">›</span></button>
    <button class="settings-row" data-setting="clear-data"><span class="settings-symbol"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"/></svg></span><span class="settings-copy"><strong>Limpar dados</strong><small>Limpe notificações, histórico e outros dados opcionais.</small></span><span class="arrow">›</span></button>
    <button class="settings-row" data-setting="release-notes"><span class="settings-symbol"><svg viewBox="0 0 24 24"><path d="M5 3h14v18l-7-4-7 4zM8 8h8M8 12h8"/></svg></span><span class="settings-copy"><strong>Notas da versão</strong><small>Confira o que mudou na v1.1.2.</small></span><span class="arrow">›</span></button>
    <button class="settings-row" data-setting="password"><span class="settings-symbol"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></span><span class="settings-copy"><strong>Alterar senha</strong><small>Atualize a senha da sua conta.</small></span><span class="arrow">›</span></button>
    ${isApp ? "" : `<button class="settings-row" data-setting="app"><span class="settings-symbol"><svg viewBox="0 0 24 24"><rect x="6" y="2.8" width="12" height="18.4" rx="2.5"/><path d="M10 6h4M11 18h2"/></svg></span><span class="settings-copy"><strong>App R.A.E.L.</strong><small>Baixe o app pela comunidade do WhatsApp para ter acesso antecipado a recursos.</small></span><span class="arrow">›</span></button>`}
    <button class="settings-row" data-setting="profile"><span class="settings-symbol"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.7-4.2 3.4-6 8-6s7.3 1.8 8 6"/></svg></span><span class="settings-copy"><strong>Personalizar perfil</strong><small>Edite sua bio, foto e banner.</small></span><span class="arrow">›</span></button>
    <button class="settings-row" data-setting="logout"><span class="settings-symbol"><svg viewBox="0 0 24 24"><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M16 16l5-4-5-4M21 12H9"/></svg></span><span class="settings-copy"><strong>Sair da conta</strong><small>Encerre a sessão neste dispositivo.</small></span><span class="arrow">›</span></button>
  </div><p class="app-version">R.A.E.L. Méritos · v1.1.2</p>`;
}

function renderScreen() {
  if (!account || account.status !== "approved") return;
  const area = $("#screenContent");
  if (!area) return;
  const renderers = { home: renderHome, payments: renderPayments, store: renderStore, analytics: renderAnalytics, contact: renderContact, other: renderOther, "release-notes": renderReleaseNotes };
  area.innerHTML = (renderers[activeView] || renderHome)();
  $$("[data-quick]", area).forEach(button => button.addEventListener("click", () => {
    const next = button.dataset.quick;
    if (next === "people") openPeople(); else switchView(next);
  }));
  $$("[data-setting]", area).forEach(button => button.addEventListener("click", () => handleSetting(button.dataset.setting)));
  const reportForm = $("#reportForm", area);
  reportForm?.addEventListener("submit", sendReport);
  $$(`[data-buy-item]`, area).forEach(button => button.addEventListener("click", () => buyItem(button.dataset.buyItem)));
  $$(`[data-edit-ticket]`, area).forEach(button => button.addEventListener("click", () => editMyTicket(button.dataset.editTicket)));
  $$(`[data-delete-ticket]`, area).forEach(button => button.addEventListener("click", () => deleteMyTicket(button.dataset.deleteTicket)));
}

const navigationSheet = $("#navigationSheet");
const navigationOverlay = $("#navigationOverlay");
const menuButton = $("#menuButton");
function openNavigation() {
  navigationSheet?.classList.add("is-open");
  navigationOverlay?.classList.add("is-open");
  navigationSheet?.setAttribute("aria-hidden", "false");
  navigationOverlay?.setAttribute("aria-hidden", "false");
  menuButton?.setAttribute("aria-expanded", "true");
  document.body.classList.add("navigation-open");
  $("#navigationClose")?.focus({ preventScroll: true });
}
function closeNavigation() {
  navigationSheet?.classList.remove("is-open");
  navigationOverlay?.classList.remove("is-open");
  navigationSheet?.setAttribute("aria-hidden", "true");
  navigationOverlay?.setAttribute("aria-hidden", "true");
  menuButton?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("navigation-open");
}
menuButton?.addEventListener("click", openNavigation);
$("#navigationClose")?.addEventListener("click", closeNavigation);
navigationOverlay?.addEventListener("click", closeNavigation);

function switchView(view) {
  closeNavigation();
  activeView = view;
  $$(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  renderScreen();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$$(".nav-button").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));

async function buyItem(itemId) {
  const item = shopItems[itemId];
  if (!item) return;
  openModal(`Comprar ${item.name || "item"}?`, `<p class="muted">Esta compra usará <strong>${number(item.price)} méritos</strong> do seu saldo. A compra será registrada no histórico.</p>`, `<button class="secondary-button" id="cancelPurchase">Cancelar</button><button class="primary-button" id="confirmPurchase">Confirmar compra</button>`);
  $("#cancelPurchase").addEventListener("click", closeModal);
  $("#confirmPurchase").addEventListener("click", async () => {
    const confirmButton = $("#confirmPurchase"); confirmButton.disabled = true; confirmButton.textContent = "Processando…";
    try {
      const result = await call("purchaseItem")({ itemId });
      closeModal(); toast(`Compra concluída: ${result.data.itemName}.`, "Você comprou algo");
      switchView(isApp ? "store" : "payments");
    } catch (error) { confirmButton.disabled = false; confirmButton.textContent = "Confirmar compra"; toast(errorMessage(error), "Compra não concluída", true); }
  });
}

async function sendReport(event) {
  event.preventDefault();
  const message = $("#reportMessage").value.trim();
  const err = $("#reportError");
  if (message.length < 5) { showError(err, "Escreva pelo menos 5 caracteres."); return; }
  const button = $("#reportForm button[type=submit]");
  button.disabled = true; button.textContent = "Enviando…";
  try {
    await call("submitReport")({ message });
    $("#reportMessage").value = "";
    showError(err, "");
    toast("Seu relato foi enviado. Você receberá uma notificação quando houver uma resposta.", "Relato enviado");
  } catch (error) { showError(err, errorMessage(error)); }
  finally { button.disabled = false; button.textContent = "Enviar relato"; }
}

function handleSetting(setting) {
  if (setting === "theme") return openThemeSettings();
  if (setting === "password") return openPasswordSettings();
  if (setting === "profile") return openEditProfile();
  if (setting === "logout") return askLogout();
  if (setting === "app") return openModal("Versão para app", `<p class="muted">O app R.A.E.L. Méritos tem análises beta, loja de méritos e personalização de perfil. O acesso é compartilhado pela comunidade do WhatsApp.</p>`);
  if (setting === "popup-color") return openPopupColorSettings();
  if (setting === "clear-data") return openClearDataSettings();
  if (setting === "release-notes") return showReleaseNotes(false);
}

function askLogout() {
  openModal("Sair da conta?", `<p class="muted">Você será desconectado deste dispositivo. Seus méritos e seu cadastro não serão apagados.</p>`, `<button class="secondary-button" id="cancelLogout">Cancelar</button><button class="primary-button" id="confirmLogout">Sair da conta</button>`);
  $("#cancelLogout").addEventListener("click", closeModal);
  $("#confirmLogout").addEventListener("click", async () => { closeModal(); cleanupListeners(); await signOut(auth); });
}

function openThemeSettings() {
  const selected = document.body.classList.contains("dark-theme") ? "dark" : "light";
  openModal("Aparência", `<p class="muted">Escolha como o sistema aparece neste dispositivo.</p><div class="theme-options"><button class="theme-option ${selected === "light" ? "chosen" : ""}" data-theme="light">Tema claro</button><button class="theme-option ${selected === "dark" ? "chosen" : ""}" data-theme="dark">Tema escuro</button></div>`);
  $$("[data-theme]").forEach(button => button.addEventListener("click", () => {
    document.body.classList.toggle("dark-theme", button.dataset.theme === "dark");
    localStorage.setItem("rael-theme", button.dataset.theme);
    $$("[data-theme]").forEach(item => item.classList.toggle("chosen", item === button));
    toast(button.dataset.theme === "dark" ? "Tema escuro ativado." : "Tema claro ativado.", "Aparência");
  }));
}

function openPasswordSettings() {
  openModal("Alterar senha", `<form id="passwordChangeForm" class="stack-form"><label>Senha atual<input class="field-input" id="currentPassword" type="password" autocomplete="current-password" required></label><label>Nova senha<input class="field-input" id="newPassword" type="password" minlength="8" autocomplete="new-password" required></label><label>Repita a nova senha<input class="field-input" id="repeatPassword" type="password" minlength="8" autocomplete="new-password" required></label><p class="form-error" id="passwordChangeError"></p><button class="primary-button" type="submit">Salvar nova senha</button></form>`);
  $("#passwordChangeForm").addEventListener("submit", async event => {
    event.preventDefault();
    const oldPassword = $("#currentPassword").value;
    const nextPassword = $("#newPassword").value;
    const repeated = $("#repeatPassword").value;
    if (nextPassword.length < 8) return showError($("#passwordChangeError"), "Use pelo menos 8 caracteres.");
    if (nextPassword !== repeated) return showError($("#passwordChangeError"), "As novas senhas não são iguais.");
    try {
      const credential = EmailAuthProvider.credential(syntheticEmail(normalizeUsername(account.username)), oldPassword);
      await reauthenticateWithCredential(auth.currentUser, credential);
      await updatePassword(auth.currentUser, nextPassword);
      closeModal(); toast("Sua senha foi atualizada.", "Senha alterada");
    } catch (error) { showError($("#passwordChangeError"), errorMessage(error)); }
  });
}

function openNotifications() {
  const items = notifications.length ? notifications.map(item => `<article class="notification-item"><span class="notification-icon"><svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></span><div style="flex:1;min-width:0"><strong>${esc(item.title || "Notificação")}</strong><p>${esc(item.body || "")}</p><time>${esc(formatDate(item.createdAt))}</time>${item.type === "ticket-reply" ? `<p><button class="subtle-link" data-open-contact>Ver resposta</button></p>` : ""}${!item.read ? `<p><button class="subtle-link" data-read-notif="${esc(item.id)}">Marcar como lida</button></p>` : ""}</div>${item.read ? "" : `<span class="unread-dot" title="Não lida"></span>`}</article>`).join("") : emptyState("Tudo em dia", "Suas notificações aparecerão aqui.", "bell");
  openModal("Notificações", `<div>${items}</div>`, `${notifications.some(item => !item.read) ? `<button class="secondary-button" id="markAllRead">Marcar como lidas</button>` : ""}<button class="danger-button" id="clearNotifications">Limpar notificações</button>`);
  $$("[data-open-contact]").forEach(button => button.addEventListener("click", () => { closeModal(); switchView("contact"); }));
  $$('[data-read-notif]').forEach(button => button.addEventListener("click", async () => {
    try {
      const id = button.dataset.readNotif;
      await call("markNotificationRead")({ id });
      notifications = notifications.map(item => item.id === id ? { ...item, read: true } : item);
      closeModal(); openNotifications();
    }
    catch (error) { toast(errorMessage(error), "Erro", true); }
  }));
  $("#markAllRead")?.addEventListener("click", async () => {
    const unread = notifications.filter(item => !item.read);
    try { await Promise.all(unread.map(item => call("markNotificationRead")({ id: item.id }))); closeModal(); toast("Notificações marcadas como lidas."); }
    catch (error) { toast(errorMessage(error), "Erro", true); }
  });
  $("#clearNotifications")?.addEventListener("click", () => { closeModal(); confirmClearData("notifications"); });
}
$("#notificationsButton")?.addEventListener("click", openNotifications);

async function openPeople() {
  try {
    const snap = await get(ref(db, "publicProfiles"));
    lastDirectorySnapshot = snap.val() || {};
    renderPeopleModal();
  } catch (error) { toast(errorMessage(error), "Não foi possível carregar a comunidade", true); }
}

function renderPeopleModal() {
  const query = directoryQuery.trim().toLowerCase();
  const people = Object.entries(lastDirectorySnapshot).map(([uid, value]) => ({ uid, ...value }))
    .filter(item => item.status === "approved" && item.uid !== currentUser?.uid && `${item.username || ""} ${item.bio || ""}`.toLowerCase().includes(query))
    .sort((a, b) => String(a.username || "").localeCompare(String(b.username || ""), "pt-BR"));
  const list = people.length ? people.map(person => `<div class="person-row" role="button" tabindex="0" data-person-uid="${esc(person.uid)}"><img src="${safeImage(person.photoURL)}" alt="" loading="lazy"><div><strong>${esc(person.username || "Membro")}</strong><small>${esc(person.bio || "Membro da comunidade R.A.E.L.").slice(0, 88)}</small></div><span class="person-arrow">›</span></div>`).join("") : emptyState("Ninguém encontrado", "Tente outro nome ou parte da bio.", "people");
  openModal("Pessoas da comunidade", `${isApp ? "<p class='muted' style='font-size:12px;margin:0 0 12px'>Busque por nome ou bio.</p>" : ""}<div class="search-box"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input class="field-input" id="directorySearch" value="${esc(directoryQuery)}" placeholder="Buscar usuários…" aria-label="Buscar usuários"></div><div id="peopleList">${list}</div>`);
  const bindRows = () => {
    $$("[data-person-uid]", modalContent).forEach(row => {
      const open = () => showPublicProfile(row.dataset.personUid);
      row.addEventListener("click", open);
      row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") open(); });
    });
  };
  bindRows();
  $("#directorySearch")?.addEventListener("input", event => {
    directoryQuery = event.target.value;
    const next = renderPeopleHTML(directoryQuery);
    $("#peopleList").innerHTML = next;
    bindRows();
  });
}
function renderPeopleHTML(queryValue) {
  const query = String(queryValue || "").trim().toLowerCase();
  const people = Object.entries(lastDirectorySnapshot).map(([uid, value]) => ({ uid, ...value })).filter(item => item.status === "approved" && item.uid !== currentUser?.uid && `${item.username || ""} ${item.bio || ""}`.toLowerCase().includes(query)).sort((a,b)=>String(a.username||"").localeCompare(String(b.username||""),"pt-BR"));
  return people.length ? people.map(person => `<div class="person-row" role="button" tabindex="0" data-person-uid="${esc(person.uid)}"><img src="${safeImage(person.photoURL)}" alt="" loading="lazy"><div><strong>${esc(person.username || "Membro")}</strong><small>${esc(person.bio || "Membro da comunidade R.A.E.L.").slice(0, 88)}</small></div><span class="person-arrow">›</span></div>`).join("") : emptyState("Ninguém encontrado", "Tente outro nome ou parte da bio.", "people");
}
$("#peopleButton")?.addEventListener("click", openPeople);

async function showPublicProfile(uid) {
  const person = lastDirectorySnapshot[uid];
  if (!person || person.status !== "approved") return;
  if (uid !== currentUser.uid) call("recordProfileView")({ uid }).catch(() => {});
  const bannerUrl = /^(https:\/\/|data:image\/(?:jpeg|png|webp);base64,)/i.test(person.bannerURL || "") ? person.bannerURL : "";
  openModal("Perfil da comunidade", `<div class="profile-hero"><div class="profile-banner"></div><div class="profile-avatar-wrap"><img src="${safeImage(person.photoURL)}" alt="Foto de ${esc(person.username)}"></div></div><div class="profile-title-line"><h3>${esc(person.username || "Membro")}</h3><p>${esc(person.bio || "Este membro ainda não escreveu uma bio.")}</p></div>${isApp ? "" : `<div class="profile-warning">Baixe o app pela comunidade do WhatsApp para liberar a personalização completa do perfil, incluindo banner.</div>`}`, `<button class="secondary-button" id="closeProfile">Fechar</button>${uid === currentUser.uid ? `<button class="primary-button" id="editProfileFromView">Editar perfil</button>` : ""}`);
  if (bannerUrl) { try { const parsed = new URL(bannerUrl); if (parsed.protocol === "https:" || parsed.protocol === "data:") $(".profile-banner").style.backgroundImage = `url(${JSON.stringify(parsed.href)})`; } catch {} }
  $("#closeProfile")?.addEventListener("click", closeModal);
  $("#editProfileFromView")?.addEventListener("click", openEditProfile);
}

function compressProfileImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) return reject(new Error("Escolha um arquivo de imagem válido."));
    if (file.size > 12 * 1024 * 1024) return reject(new Error("A imagem original deve ter menos de 12 MB."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler essa imagem."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Esse arquivo de imagem não pôde ser aberto."));
      image.onload = () => {
        const maxSize = 360;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Este navegador não conseguiu processar a imagem."));
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        let quality = 0.82;
        let data = canvas.toDataURL("image/jpeg", quality);
        while (data.length > 280000 && quality > 0.38) { quality -= 0.08; data = canvas.toDataURL("image/jpeg", quality); }
        if (data.length > 300000) return reject(new Error("A imagem ficou grande demais mesmo após a compressão. Escolha outra foto."));
        resolve(data);
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function compressBannerImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) return reject(new Error("Escolha um arquivo de imagem válido."));
    if (file.size > 12 * 1024 * 1024) return reject(new Error("A imagem original deve ter menos de 12 MB."));
    const reader = new FileReader(); reader.onerror = () => reject(new Error("Não foi possível ler essa imagem."));
    reader.onload = () => {
      const image = new Image(); image.onerror = () => reject(new Error("Esse arquivo de imagem não pôde ser aberto."));
      image.onload = () => {
        const maxSize = 1100, scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext("2d"); if (!ctx) return reject(new Error("Este navegador não conseguiu processar a imagem."));
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        let quality = 0.78, data = canvas.toDataURL("image/jpeg", quality);
        while (data.length > 480000 && quality > 0.32) { quality -= 0.07; data = canvas.toDataURL("image/jpeg", quality); }
        if (data.length > 520000) return reject(new Error("O banner ficou grande demais após a compressão. Escolha outra imagem."));
        resolve(data);
      }; image.src = String(reader.result);
    }; reader.readAsDataURL(file);
  });
}

function openEditProfile() {
  let photoData = "", bannerData = "";
  openModal("Personalizar perfil", `<form id="profileEditForm" class="stack-form"><label class="field-label">Nome da comunidade<input class="field-input" value="${esc(profile?.username || account.username)}" disabled><small class="muted">O nome de usuário não pode ser alterado.</small></label>
  <div class="profile-upload-row"><img id="profileUploadPreview" src="${safeImage(profile?.photoURL)}" alt="Prévia da foto de perfil"><label class="field-label">Foto de perfil<input class="field-input" id="editPhotoFile" type="file" accept="image/*"><small class="muted">Escolha uma foto do celular ou computador.</small></label></div>
  <label class="field-label">Bio<textarea class="field-textarea" id="editBio" maxlength="180" rows="3" placeholder="Conte um pouco sobre você">${esc(profile?.bio || "")}</textarea></label>
  <div class="profile-upload-row banner-upload-row"><img id="bannerUploadPreview" src="${safeImage(profile?.bannerURL)}" alt="Prévia do banner" class="banner-upload-preview"><label class="field-label">Banner do perfil<input class="field-input" id="editBannerFile" type="file" accept="image/*"><small class="muted">O banner será comprimido antes de salvar.</small></label></div>
  <p class="form-error" id="profileEditError"></p><button class="primary-button" type="submit">Salvar perfil</button></form>`);
  $("#editPhotoFile")?.addEventListener("change", async () => { const file = $("#editPhotoFile").files?.[0]; if (!file) return; try { photoData = await compressProfileImage(file); $("#profileUploadPreview").src = photoData; showError($("#profileEditError"), ""); } catch (error) { showError($("#profileEditError"), error.message); } });
  $("#editBannerFile")?.addEventListener("change", async () => { const file = $("#editBannerFile").files?.[0]; if (!file) return; try { bannerData = await compressBannerImage(file); $("#bannerUploadPreview").src = bannerData; showError($("#profileEditError"), ""); } catch (error) { showError($("#profileEditError"), error.message); } });
  $("#profileEditForm").addEventListener("submit", async event => {
    event.preventDefault(); const bio = $("#editBio").value.trim();
    const photoURL = photoData || (profile?.photoURL || ""), bannerURL = bannerData || (profile?.bannerURL || "");
    const submitButton = $("#profileEditForm button[type=submit]"); submitButton.disabled = true; submitButton.textContent = "Salvando…";
    try {
      await set(ref(db, `publicProfiles/${currentUser.uid}`), { ...profile, username: account.username, status: "approved", bio, photoURL, bannerURL });
      profile = { ...profile, bio, photoURL, bannerURL }; $("#miniAvatar").src = safeImage(photoURL); $("#miniUsername").textContent = profile.username;
      closeModal(); toast("Seu perfil foi atualizado.", "Perfil salvo");
    } catch (error) { showError($("#profileEditError"), error.message || errorMessage(error)); }
    finally { submitButton.disabled = false; submitButton.textContent = "Salvar perfil"; }
  });
}

$("#myProfileButton")?.addEventListener("click", () => {
  lastDirectorySnapshot[currentUser.uid] = { ...profile, status: "approved" };
  showPublicProfile(currentUser.uid);
});


function renderReleaseNotes() { return `<div class="section-heading"><div><h2>Novidades · v1.1.2</h2><p>O que mudou nesta atualização.</p></div></div><div class="notice-block release-notes">${RELEASE_NOTES}</div>`; }
function showReleaseNotes(firstLaunch = false) {
  openModal("Novidades · v1.1.2", `<div class="release-notes">${RELEASE_NOTES}</div>`, `<button class="primary-button" id="closeReleaseNotes">${firstLaunch ? "Entendi" : "Fechar"}</button>`);
  $("#closeReleaseNotes")?.addEventListener("click", () => { if (isApp) localStorage.setItem("rael-release-seen", "v1.1.2"); closeModal(); });
  if (firstLaunch && isApp) localStorage.setItem("rael-release-seen", "v1.1.2");
}
function openPopupColorSettings() {
  const current = localStorage.getItem("rael-popup-color") || "#f06b2b";
  openModal("Cor dos pop-ups", `<p class="muted">Escolha uma cor para o destaque das notificações e caixas de diálogo.</p><label class="field-label">Cor personalizada<input id="popupColorPicker" class="field-input color-picker" type="color" value="${esc(current)}"></label><div class="color-preview" id="popupColorPreview">Prévia de notificação</div>`, `<button class="secondary-button" id="resetPopupColor">Padrão</button><button class="primary-button" id="savePopupColor">Salvar cor</button>`);
  $("#popupColorPicker")?.addEventListener("input", event => { $("#popupColorPreview").style.borderColor = event.target.value; $("#popupColorPreview").style.setProperty("--popup-color", event.target.value); });
  $("#savePopupColor")?.addEventListener("click", () => { const color = $("#popupColorPicker").value; localStorage.setItem("rael-popup-color", color); document.documentElement.style.setProperty("--popup-color", color); closeModal(); toast("Cor dos pop-ups atualizada."); });
  $("#resetPopupColor")?.addEventListener("click", () => { localStorage.removeItem("rael-popup-color"); document.documentElement.style.removeProperty("--popup-color"); closeModal(); toast("Cor padrão restaurada."); });
}
function openClearDataSettings() {
  openModal("Limpar dados", `<p class="muted">Essas ações não alteram seu saldo. Comprovantes de compra ficam preservados para a administração concluir as entregas.</p><div class="clear-data-options"><button class="secondary-button" data-clear-kind="notifications">Limpar notificações</button><button class="secondary-button" data-clear-kind="history">Limpar histórico de méritos e compras</button>${isApp ? `<button class="secondary-button" data-clear-kind="analytics">Limpar dados das análises</button>` : ""}</div>`);
  $$('[data-clear-kind]').forEach(button => button.addEventListener("click", () => { closeModal(); confirmClearData(button.dataset.clearKind); }));
}
function confirmClearData(kind) {
  const descriptions = { notifications: "As notificações desta conta serão removidas.", history: "O histórico de movimentações será removido, mas o saldo e os comprovantes de compra da administração não serão alterados.", analytics: "Os números de análises desta conta voltarão a zero. O saldo real não muda." };
  const labels = { notifications: "notificações", history: "histórico", analytics: "dados das análises" };
  openModal(`Limpar ${labels[kind] || "dados"}?`, `<p class="muted">${descriptions[kind] || "Esta ação não pode ser desfeita."}</p>`, `<button class="secondary-button" id="cancelClearData">Cancelar</button><button class="danger-button" id="confirmClearData">Limpar</button>`);
  $("#cancelClearData")?.addEventListener("click", closeModal);
  $("#confirmClearData")?.addEventListener("click", async () => { const button = $("#confirmClearData"); button.disabled = true; button.textContent = "Limpando…"; try { await call("clearMemberData")({ kind }); if (kind === "notifications") notifications = []; if (kind === "history") transactions = []; if (kind === "analytics") stats = { earned: 0, lost: 0, views: 0 }; closeModal(); renderScreen(); toast("Dados limpos. Seu saldo foi mantido."); } catch (error) { closeModal(); toast(errorMessage(error), "Não foi possível limpar", true); } });
}
async function editMyTicket(ticketId) {
  const ticket = tickets[ticketId]; if (!ticket) return;
  openModal("Editar solicitação", `<p class="muted">Se já havia uma resposta, a edição reabre o relato e remove a resposta anterior para a administração analisar a versão atualizada.</p><form id="editTicketForm" class="stack-form"><label class="field-label">Relato<textarea id="editTicketMessage" class="field-textarea" minlength="5" maxlength="1500" required>${esc(ticket.message || "")}</textarea></label><p class="form-error" id="editTicketError"></p><button class="primary-button" type="submit">Salvar alterações</button></form>`);
  $("#editTicketForm")?.addEventListener("submit", async event => { event.preventDefault(); const button = $("#editTicketForm button[type=submit]"); button.disabled = true; try { await call("editOwnTicket")({ ticketId, message: $("#editTicketMessage").value }); closeModal(); toast("Solicitação atualizada."); } catch (error) { showError($("#editTicketError"), errorMessage(error)); } finally { button.disabled = false; } });
}
function deleteMyTicket(ticketId) {
  openModal("Excluir solicitação?", `<p class="muted">Este relato será removido do seu histórico e da fila de administração. Isso não afeta compras nem seu saldo.</p>`, `<button class="secondary-button" id="cancelDeleteTicket">Cancelar</button><button class="danger-button" id="confirmDeleteTicket">Excluir</button>`);
  $("#cancelDeleteTicket")?.addEventListener("click", closeModal);
  $("#confirmDeleteTicket")?.addEventListener("click", async () => { try { await call("deleteOwnTicket")({ ticketId }); closeModal(); toast("Solicitação excluída."); } catch (error) { closeModal(); toast(errorMessage(error), "Erro", true); } });
}
let pendingPhotoData = "", pendingBannerData = "";
async function loadPendingProfileDraft(uid) {
  try {
    const snap = await get(ref(db, `pendingProfiles/${uid}`)); const draft = snap.val() || {};
    pendingPhotoData = draft.photoURL || ""; pendingBannerData = draft.bannerURL || "";
    if ($("#pendingBio")) $("#pendingBio").value = draft.bio || "";
    if ($("#pendingPhotoPreview")) $("#pendingPhotoPreview").src = safeImage(draft.photoURL);
    if ($("#pendingBannerPreview")) $("#pendingBannerPreview").src = safeImage(draft.bannerURL);
  } catch (error) { toast(errorMessage(error), "Não foi possível carregar o rascunho", true); }
}
function setupPendingProfileForm() {
  $("#pendingPhotoFile")?.addEventListener("change", async () => { const file = $("#pendingPhotoFile").files?.[0]; if (!file) return; try { pendingPhotoData = await compressProfileImage(file); $("#pendingPhotoPreview").src = pendingPhotoData; showError($("#pendingProfileError"), ""); } catch (error) { showError($("#pendingProfileError"), error.message); } });
  $("#pendingBannerFile")?.addEventListener("change", async () => { const file = $("#pendingBannerFile").files?.[0]; if (!file) return; try { pendingBannerData = await compressBannerImage(file); $("#pendingBannerPreview").src = pendingBannerData; showError($("#pendingProfileError"), ""); } catch (error) { showError($("#pendingProfileError"), error.message); } });
  $("#pendingProfileForm")?.addEventListener("submit", async event => { event.preventDefault(); const button = $("#pendingProfileForm button[type=submit]"); button.disabled = true; button.textContent = "Salvando…"; try { await call("savePendingProfile")({ bio: $("#pendingBio").value.trim(), photoURL: pendingPhotoData, bannerURL: pendingBannerData }); toast("Personalização salva. Ela será aplicada se o cadastro for aprovado.", "Rascunho salvo"); } catch (error) { showError($("#pendingProfileError"), errorMessage(error)); } finally { button.disabled = false; button.textContent = "Salvar personalização"; } });
}
setupPendingProfileForm();

const savedTheme = localStorage.getItem("rael-theme");
if (savedTheme === "dark") document.body.classList.add("dark-theme");
const savedPopupColor = localStorage.getItem("rael-popup-color");
if (savedPopupColor && /^#[0-9a-f]{6}$/i.test(savedPopupColor)) document.documentElement.style.setProperty("--popup-color", savedPopupColor);
onAuthStateChanged(auth, async user => {
  if (authBusy) return;
  try { await loadAccount(user); }
  finally { $("#authLoading")?.classList.add("hidden"); }
});
