// Operações do R.A.E.L. feitas diretamente no Firebase Web SDK.
// Este arquivo roda no navegador; não usa Cloud Functions para as ações comuns.
import { auth, db, normalizeUsername } from "./firebase.js";
import {
  ref, get, set, update, remove, push, runTransaction, increment
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const STARTING_BALANCE = 100;
const ADMIN_ACCESS_CODE = "2323"; // Código do painel, intencionalmente mantido no frontend.
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function signedInUser() {
  if (!auth.currentUser) fail("auth/unauthenticated", "Entre na sua conta primeiro.");
  return auth.currentUser;
}
async function requireAdmin() {
  const user = signedInUser();
  const snap = await get(ref(db, `admins/${user.uid}`));
  if (!snap.exists()) fail("permission-denied", "Acesso restrito aos administradores.");
  return { user, admin: snap.val() };
}
async function isFirstAdmin(uid) {
  const firstSnap = await get(ref(db, "system/firstAdminUid"));
  if (firstSnap.exists()) return firstSnap.val() === uid;
  // Compatibilidade com bancos criados antes do marcador do primeiro admin.
  const adminsSnap = await get(ref(db, "admins"));
  const entries = Object.entries(adminsSnap.val() || {}).sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0));
  return entries[0]?.[0] === uid;
}
async function requireFirstAdmin() {
  const context = await requireAdmin();
  if (!(await isFirstAdmin(context.user.uid))) fail("permission-denied", "Somente o primeiro administrador pode controlar contas administrativas.");
  return context;
}
function cleanUsername(value) {
  if (typeof value !== "string") fail("invalid-argument", "Informe um nome de usuário.");
  const username = value.trim();
  if (!/^[A-Za-z0-9._-]{3,24}$/.test(username)) {
    fail("invalid-argument", "Use de 3 a 24 caracteres: letras sem acento, números, ponto, hífen ou sublinhado.");
  }
  return { username, key: normalizeUsername(username) };
}
async function reserveUsername(key, uid) {
  const result = await runTransaction(ref(db, `usernameIndex/${key}`), current => {
    if (current === null || current === uid) return uid;
    return; // Aborta a transação se o nome pertencer a outra conta.
  });
  if (!result.committed && result.snapshot.val() !== uid) {
    fail("already-exists", "Esse nome de usuário já está em uso.");
  }
}
function baseAccount(uid, username, status, role = "member") {
  return {
    uid, username, status, role,
    meritos: status === "approved" ? STARTING_BALANCE : 0,
    createdAt: Date.now()
  };
}
function baseProfile(username, status = "pending", role = "member") {
  return { username, bio: "", photoURL: "", bannerURL: "", status, role };
}
function addNotification(updates, uid, title, body, type = "general", extra = {}) {
  const noticeRef = push(ref(db, `notifications/${uid}`));
  updates[`notifications/${uid}/${noticeRef.key}`] = {
    title, body, type, createdAt: Date.now(), read: false, ...extra
  };
}
async function writeNewAccount(uid, username, role, status = "approved", reason = "Saldo inicial da conta") {
  const now = Date.now();
  const updates = {};
  updates[`accounts/${uid}`] = baseAccount(uid, username, status, role);
  updates[`publicProfiles/${uid}`] = baseProfile(username, status, role);
  updates[`stats/${uid}`] = { earned: status === "approved" ? STARTING_BALANCE : 0, lost: 0, views: 0 };
  updates[`adminDirectory/${uid}`] = {
    uid, username, status, role,
    meritos: status === "approved" ? STARTING_BALANCE : 0,
    createdAt: now
  };
  if (status === "approved") {
    updates[`transactions/${uid}/initial`] = {
      amount: STARTING_BALANCE, kind: "credit", reason, createdAt: now
    };
  }
  await update(ref(db), updates);
}

const operations = {
  async registerMember({ username }) {
    const user = signedInUser();
    const { username: clean, key } = cleanUsername(username);
    if ((await get(ref(db, `accounts/${user.uid}`))).exists()) {
      fail("already-exists", "Esta conta já foi cadastrada.");
    }
    await reserveUsername(key, user.uid);
    try {
      await writeNewAccount(user.uid, clean, "member", "pending");
    } catch (error) {
      await remove(ref(db, `usernameIndex/${key}`)).catch(() => {});
      throw error;
    }
    return { status: "pending" };
  },

  async registerFirstAdmin({ username, code }) {
    const user = signedInUser();
    if (String(code || "") !== ADMIN_ACCESS_CODE) fail("permission-denied", "Código de acesso incorreto.");
    const adminsSnap = await get(ref(db, "admins"));
    if (adminsSnap.exists() && Object.keys(adminsSnap.val() || {}).length) {
      fail("failed-precondition", "O primeiro administrador já foi cadastrado. Peça a um admin atual para cadastrar outro.");
    }
    const { username: clean, key } = cleanUsername(username);
    if ((await get(ref(db, `accounts/${user.uid}`))).exists()) fail("already-exists", "Esta conta já foi cadastrada.");
    await reserveUsername(key, user.uid);
    const now = Date.now();
    const updates = {
      [`admins/${user.uid}`]: { uid: user.uid, username: clean, role: "admin", createdAt: now },
      [`accounts/${user.uid}`]: baseAccount(user.uid, clean, "approved", "admin"),
      [`publicProfiles/${user.uid}`]: baseProfile(clean, "approved", "admin"),
      [`stats/${user.uid}`]: { earned: STARTING_BALANCE, lost: 0, views: 0 },
      [`adminDirectory/${user.uid}`]: { uid: user.uid, username: clean, status: "approved", role: "admin", meritos: STARTING_BALANCE, createdAt: now },
      [`transactions/${user.uid}/initial`]: { amount: STARTING_BALANCE, kind: "credit", reason: "Saldo inicial", createdAt: now },
      "system/firstAdminUid": user.uid
    };
    try { await update(ref(db), updates); }
    catch (error) { await remove(ref(db, `usernameIndex/${key}`)).catch(() => {}); throw error; }
    return { ok: true };
  },

  async verifyAdminCode({ code }) {
    if (String(code || "") !== ADMIN_ACCESS_CODE) fail("permission-denied", "Código de acesso incorreto.");
    await requireAdmin();
    return { ok: true };
  },

  async createAdditionalAdmin({ uid, username }) {
    await requireFirstAdmin();
    if (!uid || uid === auth.currentUser.uid) fail("invalid-argument", "Conta administrativa inválida.");
    const { username: clean, key } = cleanUsername(username);
    if ((await get(ref(db, `accounts/${uid}`))).exists()) fail("already-exists", "Esta conta já foi cadastrada.");
    await reserveUsername(key, uid);
    const now = Date.now();
    const updates = {
      [`admins/${uid}`]: { uid, username: clean, role: "admin", createdAt: now, createdBy: auth.currentUser.uid },
      [`accounts/${uid}`]: baseAccount(uid, clean, "approved", "admin"),
      [`publicProfiles/${uid}`]: baseProfile(clean, "approved", "admin"),
      [`stats/${uid}`]: { earned: STARTING_BALANCE, lost: 0, views: 0 },
      [`adminDirectory/${uid}`]: { uid, username: clean, status: "approved", role: "admin", meritos: STARTING_BALANCE, createdAt: now },
      [`transactions/${uid}/initial`]: { amount: STARTING_BALANCE, kind: "credit", reason: "Saldo inicial da conta", createdAt: now }
    };
    try { await update(ref(db), updates); }
    catch (error) { await remove(ref(db, `usernameIndex/${key}`)).catch(() => {}); throw error; }
    return { ok: true };
  },

  async approveMember({ uid }) {
    const { user } = await requireAdmin();
    if (!uid || uid === user.uid) fail("invalid-argument", "Conta inválida.");
    const snap = await get(ref(db, `accounts/${uid}`));
    if (!snap.exists()) fail("not-found", "Conta não encontrada.");
    if (snap.val().status !== "pending") fail("failed-precondition", "Esta conta não está aguardando aprovação.");
    const now = Date.now();
    const [profileSnap, pendingSnap] = await Promise.all([
      get(ref(db, `publicProfiles/${uid}`)), get(ref(db, `pendingProfiles/${uid}`))
    ]);
    const base = profileSnap.val() || baseProfile(snap.val().username, "approved", "member");
    const draft = pendingSnap.val() || {};
    const mergedProfile = {
      ...base, ...draft, username: snap.val().username,
      status: "approved", role: snap.val().role || "member",
      bio: String(draft.bio ?? base.bio ?? "").slice(0, 180),
      photoURL: String(draft.photoURL ?? base.photoURL ?? ""),
      bannerURL: String(draft.bannerURL ?? base.bannerURL ?? "")
    };
    const updates = {
      [`accounts/${uid}/status`]: "approved",
      [`accounts/${uid}/meritos`]: STARTING_BALANCE,
      [`publicProfiles/${uid}`]: mergedProfile,
      [`pendingProfiles/${uid}`]: null,
      [`adminDirectory/${uid}/status`]: "approved",
      [`adminDirectory/${uid}/meritos`]: STARTING_BALANCE,
      [`stats/${uid}/earned`]: STARTING_BALANCE,
      [`transactions/${uid}/initial`]: { amount: STARTING_BALANCE, kind: "credit", reason: "Saldo inicial da conta", createdAt: now }
    };
    addNotification(updates, uid, "Cadastro aprovado", "Sua conta foi aprovada. Você recebeu 100 méritos para começar.", "approval");
    await update(ref(db), updates);
    return { ok: true };
  },

  async adjustMeritos({ uid, delta, reason }) {
    const { user } = await requireAdmin();
    delta = Number(delta);
    reason = String(reason || "Ajuste administrativo").trim().slice(0, 120);
    if (!uid || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000000) {
      fail("invalid-argument", "Informe uma quantidade inteira válida.");
    }
    const accountSnap = await get(ref(db, `accounts/${uid}`));
    const directorySnap = await get(ref(db, `adminDirectory/${uid}`));
    if (!accountSnap.exists() || accountSnap.val().status !== "approved") fail("failed-precondition", "A conta não está ativa.");
    if (uid !== user.uid && (await get(ref(db, `admins/${uid}`))).exists() && !(await isFirstAdmin(user.uid))) fail("permission-denied", "Somente o primeiro administrador pode ajustar os méritos de outros administradores.");
    // Bancos antigos podem ter o saldo preenchido em adminDirectory, mas não em accounts.
    const storedAccountBalance = accountSnap.val().meritos;
    const storedDirectoryBalance = directorySnap.val()?.meritos;
    const accountHasBalance = storedAccountBalance !== null && storedAccountBalance !== undefined && Number.isFinite(Number(storedAccountBalance));
    const directoryHasBalance = storedDirectoryBalance !== null && storedDirectoryBalance !== undefined && Number.isFinite(Number(storedDirectoryBalance));
    // adminDirectory is the balance the legacy admin panel displayed; prefer it when an old database has diverged mirrors.
    const seedBalance = Number(directoryHasBalance ? storedDirectoryBalance : (accountHasBalance ? storedAccountBalance : 0));
    if (!Number.isFinite(seedBalance) || seedBalance < 0) fail("failed-precondition", "O saldo atual salvo no banco é inválido. Confira a conta no Firebase.");
    const mirrorsDiffer = accountHasBalance && directoryHasBalance && Number(storedAccountBalance) !== Number(storedDirectoryBalance);
    const balance = await runTransaction(ref(db, `accounts/${uid}/meritos`), current => {
      const currentNumber = Number(current);
      const currentBalance = current === null || current === undefined || mirrorsDiffer || !Number.isFinite(currentNumber) || currentNumber < 0 ? seedBalance : currentNumber;
      if (!Number.isFinite(currentBalance) || currentBalance < 0) return;
      const next = currentBalance + delta;
      return next < 0 ? undefined : next;
    });
    if (!balance.committed) {
      const latest = Number(balance.snapshot.val() ?? seedBalance);
      if (latest + delta < 0) fail("failed-precondition", `Saldo insuficiente: a conta tem ${latest} méritos e o desconto solicitado é de ${Math.abs(delta)}.`);
      fail("unavailable", "O Firebase não confirmou a alteração. Confira a conexão e as regras do Realtime Database e tente novamente.");
    }
    const finalBalance = Number(balance.snapshot.val());
    const txnRef = push(ref(db, `transactions/${uid}`));
    const updates = {
      [`accounts/${uid}/meritos`]: finalBalance,
      [`adminDirectory/${uid}/meritos`]: finalBalance,
      [`transactions/${uid}/${txnRef.key}`]: { amount: Math.abs(delta), kind: delta > 0 ? "credit" : "debit", reason: reason || "Ajuste administrativo", adminUid: user.uid, selfAdjustment: uid === user.uid, createdAt: Date.now() }
    };
    updates[`stats/${uid}/${delta > 0 ? "earned" : "lost"}`] = increment(Math.abs(delta));
    addNotification(updates, uid,
      delta > 0 ? "Você ganhou méritos!" : "Movimentação de méritos",
      delta > 0 ? `Você recebeu ${delta} méritos. Motivo: ${reason || "ajuste administrativo"}.` : `${Math.abs(delta)} méritos foram descontados. Motivo: ${reason || "ajuste administrativo"}.`,
      delta > 0 ? "earned" : "debit");
    await update(ref(db), updates);
    return { balance: finalBalance };
  },

  async banMember({ uid, reason }) {
    const { user } = await requireAdmin();
    reason = String(reason || "Violação das regras da comunidade").trim().slice(0, 160);
    if (!uid || uid === user.uid) fail("invalid-argument", "Não é possível banir a própria conta.");
    const accountSnap = await get(ref(db, `accounts/${uid}`));
    if (!accountSnap.exists()) fail("not-found", "Conta não encontrada.");
    const targetAdmin = (await get(ref(db, `admins/${uid}`))).exists();
    if (targetAdmin && !(await isFirstAdmin(user.uid))) fail("permission-denied", "Somente o primeiro administrador pode suspender outro administrador.");
    const updates = {
      [`accounts/${uid}/status`]: "banned",
      [`publicProfiles/${uid}/status`]: "banned",
      [`adminDirectory/${uid}/status`]: "banned",
      [`pendingProfiles/${uid}`]: null
    };
    if (targetAdmin) updates[`admins/${uid}`] = null;
    addNotification(updates, uid, targetAdmin ? "Acesso administrativo removido" : "Conta suspensa", `Sua conta foi suspensa. Motivo: ${reason}`, "banned");
    await update(ref(db), updates);
    return { ok: true };
  },

  async ensureDefaultShopItems() {
    await requireAdmin();
    // v1.1.2: não cria templates automaticamente; o administrador cadastra seus próprios itens.
    return { ok: true };
  },

  async saveShopItem({ itemId, name, description, price, active, imageURL }) {
    await requireAdmin();
    name = String(name || "").trim().slice(0, 100);
    description = String(description || "").trim().slice(0, 500);
    price = Number(price);
    imageURL = String(imageURL || "");
    if (!name || !description || !Number.isInteger(price) || price < 1 || price > 1000000) fail("invalid-argument", "Informe nome, descrição e preço inteiro entre 1 e 1.000.000 méritos.");
    if (imageURL && (!/^(https:\/\/|data:image\/(?:jpeg|png|webp);base64,)/i.test(imageURL) || imageURL.length > 520000)) fail("invalid-argument", "A imagem precisa ser HTTPS ou uma imagem comprimida de até 500 KB.");
    const isEditing = Boolean(itemId && /^[A-Za-z0-9_-]{1,80}$/.test(itemId));
    const itemRef = isEditing ? ref(db, `shopItems/${itemId}`) : push(ref(db, "shopItems"));
    const oldSnap = isEditing ? await get(itemRef) : null;
    if (isEditing && !oldSnap.exists()) fail("not-found", "Este item não existe mais.");
    const old = oldSnap?.val() || {};
    await set(itemRef, { name, description, price, active: active === true, imageURL, createdAt: old.createdAt || Date.now(), updatedAt: Date.now() });
    return { id: itemRef.key };
  },

  async deleteShopItem({ itemId }) {
    await requireAdmin();
    if (!itemId || !/^[A-Za-z0-9_-]{1,80}$/.test(itemId)) fail("invalid-argument", "Item inválido.");
    const itemRef = ref(db, `shopItems/${itemId}`);
    if (!(await get(itemRef)).exists()) fail("not-found", "Item não encontrado.");
    await remove(itemRef);
    return { ok: true };
  },

  async toggleShopItem({ itemId, active }) {
    await requireAdmin();
    if (!itemId || !/^[A-Za-z0-9_-]{1,80}$/.test(itemId)) fail("invalid-argument", "Item inválido.");
    const itemRef = ref(db, `shopItems/${itemId}`);
    if (!(await get(itemRef)).exists()) fail("not-found", "Item não encontrado.");
    await update(itemRef, { active: active === true, updatedAt: Date.now() });
    return { ok: true };
  },

  async markPurchaseDelivered({ receiptId }) {
    const { user } = await requireAdmin();
    if (!receiptId || !/^[A-Za-z0-9_-]{1,100}$/.test(receiptId)) fail("invalid-argument", "Comprovante inválido.");
    const receiptRef = ref(db, `purchaseReceipts/${receiptId}`);
    const receiptSnap = await get(receiptRef);
    if (!receiptSnap.exists()) fail("not-found", "Comprovante não encontrado.");
    const receipt = receiptSnap.val();
    if (receipt.status === "delivered") fail("failed-precondition", "Este comprovante já foi marcado como entregue.");
    const now = Date.now();
    const updates = {
      [`purchaseReceipts/${receiptId}/status`]: "delivered",
      [`purchaseReceipts/${receiptId}/deliveredAt`]: now,
      [`purchaseReceipts/${receiptId}/deliveredBy`]: user.uid
    };
    addNotification(updates, receipt.uid, "Compra entregue", `A administração marcou sua compra de “${String(receipt.itemName || "item").slice(0,100)}” como entregue.`, "purchase-delivered", { receiptId });
    await update(ref(db), updates);
    return { ok: true };
  },

  async purchaseItem({ itemId }) {
    const user = signedInUser();
    const accountSnap = await get(ref(db, `accounts/${user.uid}`));
    if (!accountSnap.exists() || accountSnap.val().status !== "approved") fail("permission-denied", "Sua conta não está ativa.");
    itemId = String(itemId || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(itemId)) fail("invalid-argument", "Item inválido.");
    const itemSnap = await get(ref(db, `shopItems/${itemId}`));
    if (!itemSnap.exists()) fail("not-found", "Este item não está disponível.");
    const item = itemSnap.val();
    const itemName = String(item.name || "Item da comunidade").slice(0, 100);
    const price = Number(item.price);
    if (item.active !== true || !Number.isInteger(price) || price < 1 || price > 1000000) fail("failed-precondition", "Este item está fechado para compras no momento.");
    const dirSnap = await get(ref(db, `adminDirectory/${user.uid}`));
    const accountValue = accountSnap.val().meritos;
    const directoryValue = dirSnap.val()?.meritos;
    const mirrorsDiffer = accountValue !== null && accountValue !== undefined && directoryValue !== null && directoryValue !== undefined && Number(accountValue) !== Number(directoryValue);
    const seedBalance = Number(directoryValue ?? accountValue ?? 0);
    const balance = await runTransaction(ref(db, `accounts/${user.uid}/meritos`), current => {
      const currentNumber = Number(current);
      const currentBalance = current === null || current === undefined || mirrorsDiffer || !Number.isFinite(currentNumber) || currentNumber < 0 ? seedBalance : currentNumber;
      if (!Number.isFinite(currentBalance) || currentBalance < 0) return;
      const next = currentBalance - price;
      return next < 0 ? undefined : next;
    });
    if (!balance.committed) {
      const latest = Number(balance.snapshot.val() ?? seedBalance);
      if (latest < price) fail("failed-precondition", `Você tem ${latest} méritos e este item custa ${price}.`);
      fail("unavailable", "O Firebase não confirmou a compra. Confira a conexão e as regras do banco e tente novamente.");
    }
    const finalBalance = Number(balance.snapshot.val());
    const txnRef = push(ref(db, `transactions/${user.uid}`));
    const receiptRef = push(ref(db, "purchaseReceipts"));
    const now = Date.now();
    const updates = {
      [`accounts/${user.uid}/meritos`]: finalBalance,
      [`adminDirectory/${user.uid}/meritos`]: finalBalance,
      [`transactions/${user.uid}/${txnRef.key}`]: { amount: price, kind: "debit", reason: `Compra: ${itemName}`, purchaseId: itemId, receiptId: receiptRef.key, createdAt: now },
      [`stats/${user.uid}/lost`]: increment(price),
      [`purchaseReceipts/${receiptRef.key}`]: { id: receiptRef.key, uid: user.uid, username: String(accountSnap.val().username || "Membro"), itemId, itemName, price, imageURL: item.imageURL || "", status: "pending", createdAt: now }
    };
    addNotification(updates, user.uid, "Compra registrada", `Compra de ${itemName} confirmada por ${price} méritos. A administração foi avisada para realizar a entrega.`, "purchase", { receiptId: receiptRef.key, itemId });
    const adminsSnap = await get(ref(db, "admins"));
    for (const adminUid of Object.keys(adminsSnap.val() || {})) {
      addNotification(updates, adminUid, "Nova compra para entregar", `${String(accountSnap.val().username || "Membro")} comprou ${itemName} por ${price} méritos. Confira os comprovantes no painel.`, "purchase-admin", { receiptId: receiptRef.key, itemId });
    }
    await update(ref(db), updates);
    return { balance: finalBalance, itemName, receiptId: receiptRef.key };
  },

  async submitReport({ message }) {
    const user = signedInUser();
    const accountSnap = await get(ref(db, `accounts/${user.uid}`));
    if (!accountSnap.exists() || accountSnap.val().status !== "approved") fail("permission-denied", "Apenas contas aprovadas podem enviar relatos.");
    message = String(message || "").trim();
    if (message.length < 5 || message.length > 1500) fail("invalid-argument", "Escreva um relato de 5 a 1.500 caracteres.");
    const ticketRef = push(ref(db, `tickets/${user.uid}`));
    const now = Date.now();
    const ticket = { id: ticketRef.key, uid: user.uid, username: accountSnap.val().username, message, status: "aberto", userNotified: false, createdAt: now, updatedAt: now };
    await update(ref(db), { [`tickets/${user.uid}/${ticketRef.key}`]: ticket, [`adminTickets/${ticketRef.key}`]: ticket });
    return { id: ticketRef.key };
  },

  async adminReplyTicket({ uid, ticketId, reply }) {
    const { user } = await requireAdmin();
    reply = String(reply || "").trim().slice(0, 1500);
    if (!uid || !ticketId || !reply) fail("invalid-argument", "Escreva uma resposta.");
    const ticketSnap = await get(ref(db, `tickets/${uid}/${ticketId}`));
    if (!ticketSnap.exists()) fail("not-found", "Solicitação não encontrada.");
    const now = Date.now();
    const ticket = { ...ticketSnap.val(), status: "respondido", reply, repliedBy: user.uid, updatedAt: now, userNotified: true };
    const updates = { [`tickets/${uid}/${ticketId}`]: ticket, [`adminTickets/${ticketId}`]: ticket };
    addNotification(updates, uid, "Seu relato foi respondido", "Um administrador respondeu à sua solicitação. Abra Contato para ler a resposta.", "ticket-reply", { ticketId });
    await update(ref(db), updates);
    return { ok: true };
  },

  async adminMarkTicketRead({ uid, ticketId }) {
    await requireAdmin();
    const ticketSnap = await get(ref(db, `tickets/${uid}/${ticketId}`));
    if (!ticketSnap.exists()) fail("not-found", "Solicitação não encontrada.");
    const ticket = { ...ticketSnap.val(), status: "lido", updatedAt: Date.now() };
    const updates = { [`tickets/${uid}/${ticketId}`]: ticket, [`adminTickets/${ticketId}`]: ticket };
    addNotification(updates, uid, "Seu relato foi lido", "Um administrador marcou sua solicitação como lida.", "ticket-read", { ticketId });
    await update(ref(db), updates);
    return { ok: true };
  },


  async savePendingProfile({ bio, photoURL, bannerURL }) {
    const user = signedInUser();
    const accountSnap = await get(ref(db, `accounts/${user.uid}`));
    if (!accountSnap.exists() || accountSnap.val().status !== "pending") fail("failed-precondition", "A personalização antes da aprovação só está disponível enquanto o cadastro estiver pendente.");
    bio = String(bio || "").trim().slice(0, 180);
    photoURL = String(photoURL || ""); bannerURL = String(bannerURL || "");
    const validImage = value => !value || (/^(https:\/\/|data:image\/(?:jpeg|png|webp);base64,)/i.test(value) && value.length <= 520000);
    if (!validImage(photoURL) || !validImage(bannerURL)) fail("invalid-argument", "Escolha imagens HTTPS ou arquivos de imagem comprimidos.");
    await set(ref(db, `pendingProfiles/${user.uid}`), { username: accountSnap.val().username, bio, photoURL, bannerURL, updatedAt: Date.now() });
    return { ok: true };
  },

  async clearMemberData({ kind }) {
    const user = signedInUser();
    const accountSnap = await get(ref(db, `accounts/${user.uid}`));
    if (!accountSnap.exists() || !["approved", "pending"].includes(accountSnap.val().status)) fail("permission-denied", "Esta conta não está ativa.");
    if (kind === "notifications") {
      await remove(ref(db, `notifications/${user.uid}`));
    } else if (kind === "history") {
      await remove(ref(db, `transactions/${user.uid}`));
      // Comprovantes em purchaseReceipts nunca são apagados aqui: a administração pode precisar deles para a entrega.
    } else if (kind === "analytics") {
      await set(ref(db, `stats/${user.uid}`), { earned: 0, lost: 0, views: 0 });
      await remove(ref(db, `profileViewEvents/${user.uid}`));
    } else fail("invalid-argument", "Escolha dados válidos para limpar.");
    return { ok: true };
  },

  async editOwnTicket({ ticketId, message }) {
    const user = signedInUser();
    ticketId = String(ticketId || ""); message = String(message || "").trim().slice(0, 1500);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(ticketId) || message.length < 5) fail("invalid-argument", "Escreva um relato de pelo menos 5 caracteres.");
    const ticketRef = ref(db, `tickets/${user.uid}/${ticketId}`);
    const snap = await get(ticketRef);
    if (!snap.exists()) fail("not-found", "Solicitação não encontrada.");
    const old = snap.val();
    const now = Date.now();
    const item = { ...old, message, status: "aberto", updatedAt: now, reply: null, repliedBy: null, userNotified: false };
    const updates = { [`tickets/${user.uid}/${ticketId}`]: item, [`adminTickets/${ticketId}`]: item };
    const adminsSnap = await get(ref(db, "admins"));
    for (const adminUid of Object.keys(adminsSnap.val() || {})) addNotification(updates, adminUid, "Solicitação atualizada", `${old.username || "Um membro"} editou uma solicitação. Confira o painel.`, "ticket-updated", { ticketId });
    await update(ref(db), updates);
    return { ok: true };
  },

  async deleteOwnTicket({ ticketId }) {
    const user = signedInUser(); ticketId = String(ticketId || "");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(ticketId)) fail("invalid-argument", "Solicitação inválida.");
    const ticketRef = ref(db, `tickets/${user.uid}/${ticketId}`);
    if (!(await get(ticketRef)).exists()) fail("not-found", "Solicitação não encontrada.");
    await update(ref(db), { [`tickets/${user.uid}/${ticketId}`]: null, [`adminTickets/${ticketId}`]: null });
    return { ok: true };
  },

  async deleteAnsweredTickets() {
    await requireAdmin();
    const snap = await get(ref(db, "adminTickets"));
    const tickets = snap.val() || {};
    const updates = {}; let count = 0;
    for (const [id, item] of Object.entries(tickets)) {
      if (item?.status !== "respondido") continue;
      updates[`adminTickets/${id}`] = null;
      if (item.uid) updates[`tickets/${item.uid}/${id}`] = null;
      count++;
    }
    if (count) await update(ref(db), updates);
    return { count };
  },

  async markNotificationRead({ id }) {
    const user = signedInUser();
    if (!id) fail("invalid-argument", "Notificação inválida.");
    await set(ref(db, `notifications/${user.uid}/${id}/read`), true);
    return { ok: true };
  },

  async recordProfileView({ uid }) {
    const viewer = signedInUser();
    if (!uid || uid === viewer.uid) return { counted: false };
    const target = await get(ref(db, `accounts/${uid}`));
    const viewerAccount = await get(ref(db, `accounts/${viewer.uid}`));
    if (!target.exists() || target.val().status !== "approved" || !viewerAccount.exists() || viewerAccount.val().status !== "approved") return { counted: false };
    const now = Date.now();
    let shouldCount = false;
    const event = await runTransaction(ref(db, `profileViewEvents/${uid}/${viewer.uid}`), current => {
      if (current && now - Number(current) < DAY_MS) {
        shouldCount = false;
        return current;
      }
      shouldCount = true;
      return now;
    });
    if (event.committed && shouldCount) {
      await runTransaction(ref(db, `stats/${uid}/views`), value => Number(value || 0) + 1);
      return { counted: true };
    }
    return { counted: false };
  },

  async deleteOwnAdminAccount() {
    const { user } = await requireAdmin();
    const adminsSnap = await get(ref(db, "admins"));
    const admins = adminsSnap.val() || {};
    if (Object.keys(admins).length <= 1) fail("failed-precondition", "O último administrador não pode excluir a própria conta.");
    const account = (await get(ref(db, `accounts/${user.uid}`))).val() || {};
    const key = String(account.username || "").toLowerCase();
    const updates = {
      [`admins/${user.uid}`]: null,
      [`accounts/${user.uid}`]: null,
      [`publicProfiles/${user.uid}`]: null,
      [`adminDirectory/${user.uid}`]: null,
      [`stats/${user.uid}`]: null,
      [`pushTokens/${user.uid}`]: null
    };
    if (key) updates[`usernameIndex/${key}`] = null;
    if (await isFirstAdmin(user.uid)) {
      const next = Object.entries(admins).filter(([uid]) => uid !== user.uid).sort((a,b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0))[0];
      if (next) updates["system/firstAdminUid"] = next[0];
    }
    await update(ref(db), updates);
    return { ok: true };
  }
};

// Mantém a mesma chamada usada pela interface, para não alterar telas nem layout.
// O objeto { data } preserva o formato de retorno usado no fluxo de compras.
export const call = name => async data => {
  const operation = operations[name];
  if (!operation) throw new Error(`Operação desconhecida: ${name}`);
  return { data: await operation(data || {}) };
};
