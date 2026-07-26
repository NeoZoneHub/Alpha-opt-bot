const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const P = require("pino");
const fs = require('fs');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { countries } = require('countries-list');
const path = require('path');

const { Config } = require('./config.js');
const { getCountryFlag } = require('./flag.js');

let db = null;
let telegramOffset = 0;
let isPolling = false;

let users = {};
let userSetupState = {};

function getUser(userId) {
    if (!users[userId]) {
        users[userId] = {
            phone: null,
            otpChannel: null,
            numbersChannel: null,
            mainChannel: null,
            poweredBy: 'Digital Crew 243',
            sock: null,
            isConnected: false,
            isConnecting: false,
            reconnectAttempts: 0,
            isFirstRunHadi: true,
            isFirstRunAPI: true,
            isFirstRunFlyn: true,
            isFirstRunNumberPanel: true,
            isFirstRunHadiAPI: true,
            numberPanelStates: {},
            flynSession: null,
            numberPanelSession: null,
            hadismsSession: null,
            hadiState: { cookie: null, sessKey: null, isLoggingIn: false },
            pairingCodeSent: false,
            otpSources: {
                hadi: true,
                api: true,
                numberPanel: true,
                hadiAPI: true,
                flyn: true,
                numberPanelLogin: true
            }
        };
    }
    return users[userId];
}

function saveUsersToDB() {
    const data = JSON.stringify(users, (key, value) => {
        if (['sock', 'flynSession', 'numberPanelSession', 'hadismsSession'].includes(key)) return undefined;
        return value;
    });
    db.run("INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)", ['users', data]);
}

function loadUsersFromDB() {
    return new Promise((resolve, reject) => {
        db.get("SELECT value FROM bot_settings WHERE key = ?", ['users'], (err, row) => {
            if (err) return reject(err);
            if (row && row.value) {
                try {
                    const parsed = JSON.parse(row.value);
                    Object.keys(parsed).forEach(uid => {
                        users[uid] = { ...getUser(uid), ...parsed[uid], sock: null, isConnected: false, isConnecting: false };
                    });
                } catch(e) {}
            }
            resolve();
        });
    });
}

async function getTelegramUpdates() {
    if (!Config.telegramNotify || !Config.telegramNotify.enabled || !Config.telegramNotify.botToken) return;
    if (isPolling) return;
    isPolling = true;

    try {
        const r = await axios.get(`https://api.telegram.org/bot${Config.telegramNotify.botToken}/getUpdates`, {
            params: { offset: telegramOffset, limit: 100 },
            timeout: 30000
        });
        if (r.data && r.data.result) {
            for (const update of r.data.result) {
                telegramOffset = update.update_id + 1;
                await handleTelegramUpdate(update);
            }
        }
    } catch(e) {
        if (e.response && e.response.status === 409) {
            console.log('⚠️ Telegram 409 Conflict - another instance polling, waiting...');
        } else {
            console.log('❌ Telegram poll error:', e.message);
        }
    } finally {
        isPolling = false;
    }
}

async function sendTelegramMessage(chatId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${Config.telegramNotify.botToken}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        });
    } catch(e) {
        console.log('❌ Send msg error:', e.message);
    }
}

async function sendTelegramMessageWithButtons(chatId, text, buttons) {
    try {
        await axios.post(`https://api.telegram.org/bot${Config.telegramNotify.botToken}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch(e) {
        console.log('❌ Send buttons error:', e.message);
    }
}

async function answerCallbackQuery(queryId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${Config.telegramNotify.botToken}/answerCallbackQuery`, {
            callback_query_id: queryId,
            text: text,
            show_alert: true
        });
    } catch(e) {}
}

async function handleTelegramUpdate(update) {
    if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message.chat.id.toString();
        const userId = cb.from.id.toString();
        const data = cb.data;

        if (data === "cancel_setup") {
            delete userSetupState[userId];
            await answerCallbackQuery(cb.id, "❌ Configuration annulée!");
            await sendTelegramMessageWithButtons(chatId,
                "❌ <b>Configuration Annulée!</b>\n\nAppuyez sur Démarrer la configuration pour recommencer:",
                [[{text: "🚀 Démarrer la configuration", callback_data: "start_setup", style: "success"}]]
            );
            return;
        }

        if (data === "start_setup") {
            await answerCallbackQuery(cb.id, "✅ Démarrage de la configuration...");
            userSetupState[userId] = { step: 1 };
            await sendTelegramMessageWithButtons(chatId, 
                "📝 <b>Étape 1 sur 4</b>\n\n" +
                "📨 Envoyez votre <b>ID Newsletter</b>\n" +
                "<code>Exemple: 12@newsletter</code>\n\n" +
                "💡 C'est ici que les OTP seront transférés.",
                [[{text: "❌ Annuler", callback_data: "cancel_setup", style: "danger"}]]
            );
        }
        else if (data === "help_pair") {
            await answerCallbackQuery(cb.id, "📱 Tapez: pair VOTRE_NUMERO");
            await sendTelegramMessage(chatId,
                "📱 <b>Comment associer WhatsApp:</b>\n\n" +
                "Tapez cette commande:\n" +
                "<code>pair 9230</code>\n\n" +
                "🌍 Utilisez votre numéro AVEC l'indicatif du pays (sans le signe +)."
            );
        }
        else if (data === "help_status") {
            await answerCallbackQuery(cb.id, "📊 Tapez: status");
            await sendTelegramMessage(chatId, "📊 Tapez <code>status</code> pour vérifier vos paramètres.");
        }
        else if (data === "help_disconnect") {
            await answerCallbackQuery(cb.id, "🔌 Tapez: disconnect");
            await sendTelegramMessage(chatId, "🔌 Tapez <code>disconnect</code> pour vous déconnecter.");
        }
        else if (data === "edit_otp") {
            await answerCallbackQuery(cb.id, "✏️ Envoyez un nouvel ID Newsletter");
            userSetupState[userId] = { step: 1, editMode: true };
            await sendTelegramMessageWithButtons(chatId, "📨 Envoyez un nouvel <b>ID Newsletter</b>:",
                [[{text: "❌ Annuler", callback_data: "cancel_edit", style: "danger"}]]
            );
        }

        else if (data === "edit_numbers_channel") {
            await answerCallbackQuery(cb.id, "✏️ Envoyez un nouveau lien du Canal Numéros");
            userSetupState[userId] = { step: 4, editMode: true };
            await sendTelegramMessageWithButtons(chatId, "📲 Envoyez un nouveau <b>lien du Canal Numéros</b>:",
                [[{text: "❌ Annuler", callback_data: "cancel_edit", style: "danger"}]]
            );
        }
        else if (data === "edit_main_channel") {
            await answerCallbackQuery(cb.id, "✏️ Envoyez un nouveau lien du Canal Principal");
            userSetupState[userId] = { step: 5, editMode: true };
            await sendTelegramMessageWithButtons(chatId, "🧠 Envoyez un nouveau <b>lien du Canal Principal</b>:",
                [[{text: "❌ Annuler", callback_data: "cancel_edit", style: "danger"}]]
            );
        }
        else if (data === "edit_name") {
            await answerCallbackQuery(cb.id, "✏️ Envoyez un nouveau Nom de Marque");
            userSetupState[userId] = { step: 3, editMode: true };
            await sendTelegramMessageWithButtons(chatId, "👤 Envoyez un nouveau <b>Nom/Marque</b>:",
                [[{text: "❌ Annuler", callback_data: "cancel_edit", style: "danger"}]]
            );
        }
        else if (data === "cancel_edit") {
            delete userSetupState[userId];
            await answerCallbackQuery(cb.id, "❌ Modification annulée!");
            await sendTelegramMessageWithButtons(chatId,
                "❌ <b>Modification Annulée!</b>",
                [[{text: "✅ Retour aux paramètres", callback_data: "edit_settings", style: "success"}]]
            );
        }
        else if (data === "edit_settings") {
            await answerCallbackQuery(cb.id, "⚙️ Options de modification");
            const user = getUser(userId);
            await sendTelegramMessageWithButtons(chatId,
                "✏️ <b>Modifier les paramètres</b>\n\n" +
                "📨 Canal OTP: " + (user.otpChannel || 'Non défini') + "\n" +
                "📲 Canal Numéros: " + (user.numbersChannel || 'Non défini') + "\n" +
                "🧠 Canal Principal: " + (user.mainChannel || 'Non défini') + "\n" +
                "👤 Propulsé par: " + (user.poweredBy || 'Digital Crew 243') + "\n\n" +
                "Choisissez quoi modifier:",
                [
                    [{text: "✏️ Modifier le canal OTP", callback_data: "edit_otp", style: "primary"}],
                    [{text: "📲 Modifier le canal Numéros", callback_data: "edit_numbers_channel", style: "primary"}],
                    [{text: "🧠 Modifier le canal Principal", callback_data: "edit_main_channel", style: "primary"}],
                    [{text: "👤 Modifier le nom de marque", callback_data: "edit_name", style: "primary"}],
                    [{text: "❌ Annuler", callback_data: "cancel_edit", style: "danger"}]
                ]
            );
        }
        else if (data === "disconnect_now") {
            await answerCallbackQuery(cb.id, "🔌 Déconnexion en cours...");
            await forceDisconnectUser(userId, chatId);
        }
        else if (data === "pair_again") {
            await answerCallbackQuery(cb.id, "📱 Démarrage de l'association...");
            const user = getUser(userId);
            if (user.phone) {
                await sendTelegramMessage(chatId, "⏳ <b>Démarrage de l'association pour +" + user.phone + "...</b>\nVeuillez patienter... 🔄");
                await startUserWhatsAppPairing(userId, user.phone, chatId);
            } else {
                await sendTelegramMessage(chatId, "❌ <b>Aucun numéro de téléphone enregistré!</b>\nUtilisez: <code>pair VOTRE_NUMERO</code>");
            }
        }
        return;
    }

    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id.toString();
    let text = msg.text.trim();
    const userId = msg.from.id.toString();

    if (text.startsWith('/')) text = text.substring(1);
    const cmd = text.toLowerCase();

    if (cmd.startsWith('broadcast')) {
        const adminId = Config.telegramNotify.adminId;
        if (adminId && chatId !== adminId.toString()) {
            await sendTelegramMessage(chatId, "🚫 Seul l'administrateur peut diffuser.");
            return;
        }
        const broadcastMsg = text.substring(9).trim();
        if (!broadcastMsg) {
            await sendTelegramMessage(chatId, "❌ Utilisation: <code>broadcast Votre message ici</code>");
            return;
        }
        let sentCount = 0;
        for (const uid of Object.keys(users)) {
            try {
                await sendTelegramMessage(uid, "📢 <b>Message de diffusion</b>\n\n" + broadcastMsg);
                sentCount++;
            } catch(e) {}
        }
        await sendTelegramMessage(chatId, `✅ Diffusion envoyée à ${sentCount} utilisateurs.`);
        return;
    }

    if (cmd === 'userlist' || cmd === 'users') {
        const adminId = Config.telegramNotify.adminId;
        if (adminId && chatId !== adminId.toString()) {
            await sendTelegramMessage(chatId, "🚫 Seul l'administrateur peut voir la liste des utilisateurs.");
            return;
        }
        let list = "📋 <b>Liste des utilisateurs</b>\n\n";
        for (const uid of Object.keys(users)) {
            const u = getUser(uid);
            list += `🆔 <code>${uid}</code>\n📱 Téléphone: ${u.phone ? '+' + u.phone : 'Non défini'}\n🔌 Statut: ${u.isConnected ? '✅ Connecté' : '❌ Déconnecté'}\n\n`;
        }
        if (Object.keys(users).length === 0) list += "Aucun utilisateur pour le moment.";
        await sendTelegramMessage(chatId, list);
        return;
    }

    if (userSetupState[userId] && userSetupState[userId].step > 0) {
        const setup = userSetupState[userId];

        if (setup.step === 1) {
            const channelId = text.trim();
            if (!channelId.includes('@')) {
                await sendTelegramMessageWithButtons(chatId, "❌ <b>ID Newsletter invalide!</b>\nDoit contenir @\n\n🔄 Réessayez:",
                    [[{text: "❌ Annuler", callback_data: "cancel_setup", style: "danger"}]]
                );
                return;
            }
            const user = getUser(userId);
            user.otpChannel = channelId;
            saveUsersToDB();

            if (setup.editMode) {
                delete userSetupState[userId];
                await sendTelegramMessageWithButtons(chatId,
                    "✅ <b>Canal OTP mis à jour!</b>\n\nMaintenant: " + channelId,
                    [[{text: "✅ Retour aux paramètres", callback_data: "edit_settings", style: "success"}]]
                );
            } else {
                userSetupState[userId] = { step: 2 };
                await sendTelegramMessageWithButtons(chatId,
                    "📝 <b>Étape 2 sur 4</b>\n\n" +
                    "📲 Envoyez votre <b>lien du Canal Numéros</b>\n" +
                    "<code>Exemple: https://whatsapp.com/channel/0029VbD1PEn0y</code>\n\n" +
                    "💡 Ceci apparaîtra dans les messages OTP.",
                    [[{text: "❌ Annuler", callback_data: "cancel_setup", style: "danger"}]]
                );
            }
            return;
        }
        else if (setup.step === 2) {
            const numbersChannel = text.trim();
            const user = getUser(userId);
            user.numbersChannel = numbersChannel;
            saveUsersToDB();

            if (setup.editMode) {
                delete userSetupState[userId];
                await sendTelegramMessageWithButtons(chatId,
                    "✅ <b>Canal Numéros mis à jour!</b>\n\nMaintenant: " + numbersChannel,
                    [[{text: "✅ Retour aux paramètres", callback_data: "edit_settings", style: "success"}]]
                );
            } else {
                userSetupState[userId] = { step: 3 };
                await sendTelegramMessageWithButtons(chatId,
                    "📝 <b>Étape 3 sur 4</b>\n\n" +
                    "🧠 Envoyez votre <b>lien du Canal Principal</b>\n" +
                    "<code>Exemple: https://whatsapp.com/channel/0029Vb8nTAS9cDDf9NZk1f2m</code>\n\n" +
                    "💡 Ceci apparaîtra dans les messages OTP.",
                    [[{text: "❌ Annuler", callback_data: "cancel_setup", style: "danger"}]]
                );
            }
            return;
        }
        else if (setup.step === 3) {
            const mainChannel = text.trim();
            const user = getUser(userId);
            user.mainChannel = mainChannel;
            saveUsersToDB();

            if (setup.editMode) {
                delete userSetupState[userId];
                await sendTelegramMessageWithButtons(chatId,
                    "✅ <b>Canal Principal mis à jour!</b>\n\nMaintenant: " + mainChannel,
                    [[{text: "✅ Retour aux paramètres", callback_data: "edit_settings", style: "success"}]]
                );
            } else {
                userSetupState[userId] = { step: 4 };
                await sendTelegramMessageWithButtons(chatId,
                    "📝 <b>Étape 4 sur 4</b>\n\n" +
                    "👤 Envoyez votre <b>Nom/Marque</b>\n" +
                    "<code>Exemple: Digital Crew 243</code>\n\n" +
                    "💡 Ceci apparaîtra dans les messages OTP.",
                    [[{text: "❌ Annuler", callback_data: "cancel_setup", style: "danger"}]]
                );
            }
            return;
        }
        else if (setup.step === 4) {
            const poweredBy = text.trim();
            const user = getUser(userId);
            user.poweredBy = poweredBy;
            saveUsersToDB();

            if (setup.editMode) {
                delete userSetupState[userId];
                await sendTelegramMessageWithButtons(chatId,
                    "✅ <b>Nom de marque mis à jour!</b>\n\nMaintenant: " + poweredBy,
                    [[{text: "✅ Retour aux paramètres", callback_data: "edit_settings", style: "success"}]]
                );
            } else {
                delete userSetupState[userId];
                await sendTelegramMessageWithButtons(chatId,
                    "✅ <b>Configuration terminée!</b>\n\n" +
                    "📨 Canal OTP: " + user.otpChannel + "\n" +
                    "📲 Canal Numéros: " + user.numbersChannel + "\n" +
                    "🧠 Canal Principal: " + user.mainChannel + "\n" +
                    "👤 Propulsé par: " + user.poweredBy + "\n\n" +
                    "🎯 Associez maintenant votre numéro WhatsApp:",
                    [
                        [{text: "📱 Associer le numéro", callback_data: "help_pair", style: "success"}],
                        [{text: "✏️ Modifier les paramètres", callback_data: "edit_settings", style: "primary"}]
                    ]
                );
            }
            return;
        }
    }

    if (cmd === 'start' || cmd === 'setup') {
        await sendTelegramMessageWithButtons(chatId,
            "🤖 <b>Bienvenue sur Digital Crew OTP Bot!</b> 🚀\n\n" +
            "✨ <b>Fonctionnalités:</b>\n" +
            "• 📨 Transfert automatique d'OTP\n" +
            "• 📲 Canal Numéros\n" +
            "• 🧠 Canal Principal\n" +
            "• 👤 Marque personnalisée\n" +
            "• 📱 Support multi-panneaux\n\n" +
            "🎯 <b>Appuyez sur Démarrer la configuration pour configurer:</b>\n" +
            "1️⃣ ID Newsletter OTP\n" +
            "2️⃣ Lien du Canal Numéros\n" +
            "3️⃣ Lien du Canal Principal\n" +
            "4️⃣ Votre Nom/Marque\n" +
            "5️⃣ Associer le numéro WhatsApp\n\n" +
            "💡 Ou tapez les commandes manuellement.",
            [
                [{text: "🚀 Démarrer la configuration", callback_data: "start_setup", style: "success"}],
                [{text: "📱 Associer le numéro", callback_data: "help_pair", style: "success"}, {text: "📊 Statut", callback_data: "help_status", style: "success"}],
                [{text: "✏️ Modifier les paramètres", callback_data: "edit_settings", style: "primary"}, {text: "🔌 Déconnecter", callback_data: "help_disconnect", style: "danger"}]
            ]
        );
    }
    else if (cmd.startsWith('setotp')) {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await sendTelegramMessage(chatId, "❌ <b>Utilisation:</b>\n<code>setotp @newsletter</code>");
            return;
        }
        const channelId = parts[1].trim();
        const user = getUser(userId);
        user.otpChannel = channelId;
        saveUsersToDB();
        await sendTelegramMessage(chatId, "✅ <b>Canal OTP défini sur:</b>\n" + channelId);
    }

    else if (cmd.startsWith('setnumberschannel')) {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await sendTelegramMessage(chatId, "❌ <b>Utilisation:</b>\n<code>setnumberschannel https://whatsapp.com/channel/...</code>");
            return;
        }
        const link = parts[1].trim();
        const user = getUser(userId);
        user.numbersChannel = link;
        saveUsersToDB();
        await sendTelegramMessage(chatId, "✅ <b>Canal Numéros défini sur:</b>\n" + link);
    }
    else if (cmd.startsWith('setmainchannel')) {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await sendTelegramMessage(chatId, "❌ <b>Utilisation:</b>\n<code>setmainchannel https://whatsapp.com/channel/...</code>");
            return;
        }
        const link = parts[1].trim();
        const user = getUser(userId);
        user.mainChannel = link;
        saveUsersToDB();
        await sendTelegramMessage(chatId, "✅ <b>Canal Principal défini sur:</b>\n" + link);
    }
    else if (cmd.startsWith('setname') || cmd.startsWith('setpowered')) {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await sendTelegramMessage(chatId, "❌ <b>Utilisation:</b>\n<code>setname Digital Crew 243</code>");
            return;
        }
        const name = parts.slice(1).join(' ').trim();
        const user = getUser(userId);
        user.poweredBy = name;
        saveUsersToDB();
        await sendTelegramMessage(chatId, "✅ <b>Propulsé par défini sur:</b>\n" + name);
    }
    else if (cmd.startsWith('pair')) {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await sendTelegramMessage(chatId, "❌ <b>Utilisation:</b>\n<code>pair 923001834567</code> (sans +)");
            return;
        }
        const phone = parts[1].replace(/\D/g, '');
        if (phone.length < 10 || phone.length > 15) {
            await sendTelegramMessage(chatId, "❌ <b>Numéro invalide!</b>\nUtilisez le format avec l'indicatif du pays, ex: <code>9200</code> ou <code>66953900476</code>");
            return;
        }
        const user = getUser(userId);
        if (!user.otpChannel) {
            await sendTelegramMessage(chatId, 
                "⚠️ <b>Configuration incomplète!</b>\n\n" +
                "Exécutez d'abord la configuration pour définir votre newsletter et autres paramètres.\n" +
                "Ou utilisez: <code>setotp @newsletter</code>"
            );
            return;
        }

        if (user.isConnecting || user.pairingCodeSent) {
            await sendTelegramMessage(chatId, "⚠️ <b>Association déjà en cours!</b>\nVeuillez attendre ou tapez <code>disconnect</code> pour réinitialiser.");
            return;
        }

        user.phone = phone;
        user.pairingCodeSent = false;
        saveUsersToDB();
        await sendTelegramMessage(chatId, "⏳ <b>Démarrage de l'association pour +" + phone + "...</b>\nVeuillez patienter... 🔄");
        await startUserWhatsAppPairing(userId, phone, chatId);
    }
    else if (cmd === 'status') {
        await showStatusWithButtons(chatId, userId);
    }
    else if (cmd === 'disconnect') {
        await forceDisconnectUser(userId, chatId);
    }
    else {
        await sendTelegramMessage(chatId, 
            "❓ <b>Commande inconnue!</b>\n\n" +
            "📋 <b>Commandes disponibles:</b>\n" +
            "• <code>/start</code> - Démarrer le bot\n" +
            "• <code>pair NUMERO</code> - Associer WhatsApp\n" +
            "• <code>status</code> - Vérifier le statut\n" +
            "• <code>disconnect</code> - Se déconnecter\n" +
            "• <code>setotp ID</code> - Définir la newsletter\n" +
            "• <code>setnumberschannel URL</code> - Définir le canal numéros\n" +
            "• <code>setmainchannel URL</code> - Définir le canal principal\n" +
            "• <code>setname NOM</code> - Définir la marque\n" +
            "• <code>broadcast MSG</code> - (Admin) Envoyer à tous\n" +
            "• <code>userlist</code> - (Admin) Liste des utilisateurs"
        );
    }
}


async function sendLogoutNotification(chatId, phone) {
    const logoutMsg = 
        "🔴 <b>WhatsApp Déconnecté!</b>\n\n" +
        "Votre numéro WhatsApp a été déconnecté automatiquement.\n" +
        "Cela peut arriver si vous vous êtes connecté depuis un autre appareil ou si WhatsApp a détecté une activité inhabituelle.\n\n" +
        "⚠️ <b>Important:</b> Ne réassociez pas immédiatement. Attendez quelques minutes pour éviter un bannissement du numéro.\n\n" +
        "📱 Téléphone: +" + phone + "\n" +
        "Associer à nouveau";
    await sendTelegramMessageWithButtons(chatId, logoutMsg,
        [[{text: "📱 Associer à nouveau", callback_data: "pair_again", style: "success"}]]
    );
}

async function forceDisconnectUser(userId, chatId) {
    const user = getUser(userId);

    if (user.sock) {
        try { 
            user.sock.ev.removeAllListeners();
            user.sock.ws?.close();
            user.sock.end(); 
        } catch(e) {}
        user.sock = null;
    }

    user.isConnected = false;
    user.isConnecting = false;
    user.pairingCodeSent = false;
    user.reconnectAttempts = 0;

    const authDir = path.join(__dirname, 'auth', userId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });

    const pairingFile = `pairing_code_${userId}.txt`;
    if (fs.existsSync(pairingFile)) fs.rmSync(pairingFile, { force: true });

    saveUsersToDB();

    await sendTelegramMessageWithButtons(chatId, 
        "🔌 <b>Déconnecté!</b>\n\nVotre WhatsApp a été déconnecté.\nUtilisez <code>pair</code> pour vous reconnecter.",
        [[{text: "📱 Associer à nouveau", callback_data: "pair_again", style: "success"}]]
    );
}

async function showStatusWithButtons(chatId, userId) {
    const user = getUser(userId);

    let statusText = "📊 <b>Votre statut</b>\n\n";
    statusText += "📱 <b>Téléphone:</b> " + (user.phone ? '+' + user.phone : '❌ Non défini') + "\n";
    statusText += "📨 <b>Canal OTP:</b> " + (user.otpChannel || '❌ Non défini') + "\n";
    statusText += "📲 <b>Canal Numéros:</b> " + (user.numbersChannel || '❌ Non défini') + "\n";
    statusText += "🧠 <b>Canal Principal:</b> " + (user.mainChannel || '❌ Non défini') + "\n";
    statusText += "👤 <b>Propulsé par:</b> " + (user.poweredBy || 'Digital Crew 243') + "\n";
    statusText += "📲 <b>WhatsApp:</b> " + (user.isConnected ? '✅ Connecté' : '❌ Déconnecté') + "\n";

    const buttons = [];
    buttons.push([{text: "🔌 Déconnecter WhatsApp", callback_data: "disconnect_now", style: "danger"}]);
    buttons.push([{text: "✏️ Modifier les paramètres", callback_data: "edit_settings", style: "primary"}]);

    await sendTelegramMessageWithButtons(chatId, statusText, buttons);
}

function initDatabase() {
    return new Promise((resolve, reject) => {
        const dbPath = path.join(__dirname, 'silver_session.db');
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) { console.error('❌ DB open error:', err); return reject(err); }
        });
        db.run("CREATE TABLE IF NOT EXISTS sent_otps (msg_id TEXT PRIMARY KEY, user_id TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP)", (err) => {
            if (err) { console.error('❌ sent_otps table error:', err); return reject(err); }
            db.run("CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)", (err2) => {
                if (err2) { console.error('❌ bot_settings table error:', err2); return reject(err2); }
                console.log('✅ [DB] SQLite Database Initialized');
                resolve();
            });
        });
    });
}

function isAlreadySent(msgId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT msg_id FROM sent_otps WHERE msg_id = ?", [msgId], (err, row) => {
            if (err) reject(err); else resolve(!!row);
        });
    });
}

function markAsSent(msgId, userId) {
    db.run("INSERT OR IGNORE INTO sent_otps (msg_id, user_id) VALUES (?, ?)", [msgId, userId]);
}

function getTodayDate() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function getCountryFromPhone(phone) {
    try {
        if (!phone) return "🌍 Inconnu";
        let clean = phone.toString().replace(/[^0-9]/g, '');
        if (clean.startsWith('00')) clean = clean.slice(2);
        if (!clean.startsWith('+')) clean = '+' + clean;
        const parsed = parsePhoneNumberFromString(clean);
        if (parsed && parsed.country) {
            const country = countries[parsed.country];
            return country ? country.name : parsed.country;
        }
    } catch(e) {}
    return "🌍 Inconnu";
}

function maskPhoneNumber(phone) {
    if (!phone || phone.length < 6) return phone || '🌍 Inconnu';
    const s = phone.toString();
    return s.slice(0, 3) + '***' + s.slice(-4);
}

function extractOTP(msg) {
    if (!msg) return "❌ Aucun OTP trouvé";
    const patterns = [
        /\b\d{4,8}\b/g,
        /\b\d{3,4}[- ]?\d{3,4}\b/g,
        /OTP[:\s]*(\d{3,8})/i,
        /code[:\s]*(\d{3,8})/i,
        /verification[:\s]*(\d{3,8})/i,
        /password[:\s]*(\d{3,8})/i,
        /pin[:\s]*(\d{3,8})/i,
        /is[:\s]*(\d{3,8})/i,
        /token[:\s]*(\d{3,8})/i,
        /:(\d{4,8})\s*$/m
    ];
    for (const p of patterns) {
        const match = msg.match(p);
        if (match) {
            const otp = match[1] || match[0];
            if (otp && /^\d{3,8}$/.test(otp.replace(/[- ]/g,''))) return otp;
        }
    }
    return "❌ Aucun OTP trouvé";
}

function detectService(msg) {
    if (!msg) return "📩 SMS";
    const m = msg.toLowerCase();
    const keywords = {
        'WhatsApp': ['whatsapp','wa','wa.me'], 'Telegram': ['telegram','tg','t.me'],
        'Instagram': ['instagram','ig','insta'], 'Facebook': ['facebook','fb','meta'],
        'Google': ['google','gmail','youtube'], 'Twitter': ['twitter','x.com'],
        'Snapchat': ['snapchat','snap'], 'Discord': ['discord'],
        'Microsoft': ['microsoft','outlook','hotmail'], 'Amazon': ['amazon','aws'],
        'Apple': ['apple','icloud'], 'PayPal': ['paypal'], 'Netflix': ['netflix'],
        'Spotify': ['spotify'], 'TikTok': ['tiktok']
    };
    for (const [s, words] of Object.entries(keywords)) {
        for (const w of words) if (m.includes(w)) return s;
    }
    return "📩 SMS";
}

class Login1Session {
    constructor(config) {
        this.name = config.name || "Inconnu";
        this.base_url = config.baseURL.replace(/\/$/, '');
        this.username = config.username;
        this.password = config.password;
        this.cookie = "";
        this.logged_in = false;
        this.session = axios.create({
            headers: {"User-Agent": "Mozilla/5.0"},
            timeout: 10000,
            maxRedirects: 0,
            validateStatus: () => true
        });
    }

    _extractCookie(headers) {
        if (headers && headers['set-cookie']) {
            const c = headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (c) this.cookie = c.split(';')[0];
        }
    }

    async _login() {
        try {
            const login_page = this.base_url + "/login";
            const login_post = this.base_url + "/signin";

            console.log(`🔑 [${this.name}] Récupération de la page de connexion...`);
            const resp = await this.session.get(login_page, {
                headers: this.cookie ? {"Cookie": this.cookie} : {}
            });
            this._extractCookie(resp.headers);

            const match = resp.data.match(/What is (\d+) \+ (\d+)/);
            if (!match) {
                console.log(`⚠️ [${this.name}] Aucun captcha trouvé`);
                return false;
            }

            const captcha_answer = parseInt(match[1]) + parseInt(match[2]);
            console.log(`🧮 [${this.name}] Captcha: ${match[1]} + ${match[2]} = ${captcha_answer}`);

            const payload = {
                username: this.username,
                password: this.password,
                capt: captcha_answer
            };

            const headers = {
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": login_page,
                "Cookie": this.cookie
            };

            console.log(`🔐 [${this.name}] Soumission de la connexion...`);
            const resp2 = await this.session.post(login_post, new URLSearchParams(payload).toString(), { headers });
            this._extractCookie(resp2.headers);

            if (resp2.status === 302 || resp2.status === 301 || 
                resp2.data.toLowerCase().includes("dashboard") || 
                resp2.data.toLowerCase().includes("logout") ||
                resp2.data.toLowerCase().includes("home") ||
                resp2.data.toLowerCase().includes("agent") ||
                resp2.data.toLowerCase().includes("welcome")) {
                console.log(`✅ [${this.name}] Connexion réussie`);
                this.logged_in = true;
                return true;
            }

            console.log(`❌ [${this.name}] Échec de la connexion`);
            return false;
        } catch (e) {
            console.error(`❌ [${this.name}] Erreur de connexion:`, e.message);
            return false;
        }
    }

    async ensure_login() {
        if (!this.logged_in) {
            return await this._login();
        }
        return true;
    }

    async fetch_data() {
        if (!await this.ensure_login()) {
            return null;
        }

        const today = getTodayDate();
        let all_rows = [];
        let start = 0;
        const limit = 10000;

        while (true) {
            const params = {
                fdate1: `${today} 00:00:00`,
                fdate2: `${today} 23:59:59`,
                frange: '',
                fclient: '',
                fnum: '',
                fcli: '',
                fg: '0',
                sEcho: '1',
                iDisplayStart: start.toString(),
                iDisplayLength: limit.toString(),
                sSearch: '',
                iSortCol_0: '0',
                sSortDir_0: 'desc'
            };
            const data_url = this.base_url + "/agent/res/data_smscdr.php";
            const headers = {
                "X-Requested-With": "XMLHttpRequest",
                "Cookie": this.cookie
            };

            try {
                console.log(`📡 [${this.name}] Récupération des données... start=${start}`);
                const response = await this.session.get(data_url, { params, headers });

                if (response.status === 200) {
                    const data = response.data;
                    const rows = data.aaData || [];
                    if (!rows || rows.length === 0) break;

                    all_rows = all_rows.concat(rows);
                    if (rows.length < limit) break;
                    start += limit;
                } else {
                    break;
                }
            } catch (e) {
                console.log(`❌ [${this.name}] Erreur de récupération:`, e.message);
                break;
            }
        }

        if (all_rows.length > 0) {
            return { aaData: all_rows };
        }
        return null;
    }
}

const HADI_CONFIG = Config.Hadisms && Config.Hadisms.enabled ? Config.Hadisms : null;
const HADI_BASE_URL = HADI_CONFIG ? HADI_CONFIG.baseURL.replace(/\/$/, '') : "http://185.2.83.39/ints";
const HADI_CREDENTIALS = HADI_CONFIG ? { username: HADI_CONFIG.username, password: HADI_CONFIG.password } : { username: "silver", password: "silver" };
const HADI_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": HADI_BASE_URL,
    "Accept-Language": "en-US,en;q=0.9"
};

async function hadiLogin(userState) {
    if (!userState) userState = { cookie: null, sessKey: null, isLoggingIn: false };
    if (userState.isLoggingIn) return;
    userState.isLoggingIn = true;
    try {
        const inst = axios.create({ headers: HADI_HEADERS, timeout: 15000, maxRedirects: 0, validateStatus: () => true });
        const r1 = await inst.get(`${HADI_BASE_URL}/login`);
        let tempCookie = "";
        if (r1.headers['set-cookie']) {
            const c = r1.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            if (c) tempCookie = c.split(';')[0];
        }
        const match = r1.data.match(/What is (\d+)\s*\+\s*(\d+)\s*=\s*\?/);
        const capt = match ? parseInt(match[1])+parseInt(match[2]) : 11;
        const form = new URLSearchParams();
        form.append("username", HADI_CREDENTIALS.username);
        form.append("password", HADI_CREDENTIALS.password);
        form.append("capt", capt.toString());
        const r2 = await inst.post(`${HADI_BASE_URL}/signin`, form.toString(), {
            headers:{"Content-Type":"application/x-www-form-urlencoded","Cookie":tempCookie,"Referer":`${HADI_BASE_URL}/login`},
            maxRedirects:0, validateStatus:()=>true
        });
        if (r2.headers['set-cookie']) {
            const c = r2.headers['set-cookie'].find(x => x.includes('PHPSESSID'));
            userState.cookie = c ? c.split(';')[0] : tempCookie;
        } else userState.cookie = tempCookie;
        const r3 = await axios.get(`${HADI_BASE_URL}/agent/SMSCDRStats`, {
            headers:{...HADI_HEADERS,"Cookie":userState.cookie,"Referer":`${HADI_BASE_URL}/agent/SMSDashboard`}
        });
        const key = extractKey(r3.data);
        if (key) { userState.sessKey = key; console.log("✅ [Hadi] Connexion OK"); }
        else console.log("⚠️ [Hadi] Pas de clé");
    } catch(e) { console.error("❌ [Hadi] Échec de connexion:", e.message); }
    finally { userState.isLoggingIn = false; }
}

function extractKey(html) {
    let match = html.match(/sesskey=([^&"']+)/);
    if (match) return match[1];
    match = html.match(/sesskey\s*[:=]\s*["']([^"']+)["']/);
    return match ? match[1] : null;
}

async function fetchHadiSMS(userState) {
    if (!userState) userState = { cookie: null, sessKey: null, isLoggingIn: false };
    if (!userState.cookie || !userState.sessKey) { await hadiLogin(userState); if (!userState.sessKey) return []; }
    const today = getTodayDate();
    const url = `${HADI_BASE_URL}/agent/res/data_smscdr.php?fdate1=${today}%2000:00:00&fdate2=2099-12-31%2023:59:59&sesskey=${userState.sessKey}&iDisplayLength=10000&_=${Date.now()}`;
    try {
        const r = await axios.get(url, { headers:{...HADI_HEADERS,"Cookie":userState.cookie}, timeout:15000 });
        if (typeof r.data === 'string' && (r.data.includes('<html') || r.data.includes('login'))) {
            userState.cookie = null; userState.sessKey = null; await hadiLogin(userState); return [];
        }
        return r.data && r.data.aaData ? r.data.aaData : [];
    } catch(e) { console.log("❌ [Hadi] Récupération:", e.message); return []; }
}

async function fetchAPIData() {
    if (!Config.panelAPI || !Config.panelAPI.baseURL) return [];
    try {
        const dateStr = new Date().toISOString().split('T')[0];
        const url = `${Config.panelAPI.baseURL}?token=${Config.panelAPI.token}&dt1=${dateStr}%2000:00:00&dt2=${dateStr}%2023:59:59&records=10000`;
        const r = await axios.get(url, { headers:{'User-Agent':'Mozilla/5.0'}, timeout:10000 });
        if (Array.isArray(r.data)) return r.data.map(row => ({service:row[0]||'Inconnu',phone:row[1]||'',message:row[2]||'',time:row[3]||new Date().toISOString()}));
    } catch(e) { console.log("❌ [API]:", e.message); }
    return [];
}

async function fetchNumberPanelSMS(apiConfig) {
    try {
        const url = `${apiConfig.url}?type=${apiConfig.type}`;
        const r = await axios.get(url, { headers:{'User-Agent':'Mozilla/5.0'}, timeout:10000 });
        let items = [];
        if (Array.isArray(r.data)) items = r.data;
        else if (r.data && Array.isArray(r.data.data)) items = r.data.data;
        else if (r.data && Array.isArray(r.data.records)) items = r.data.records;
        else if (r.data && Array.isArray(r.data.result)) items = r.data.result;
        else { console.log(`⚠️ [${apiConfig.name}] Format inconnu`); return []; }
        return items.map(i => ({phone:i.phone||i.number||i.mobile||'',message:i.message||i.msg||i.text||'',service:i.service||i.source||apiConfig.name,time:i.time||i.created_at||i.date||new Date().toISOString()}));
    } catch(e) { console.log(`❌ [${apiConfig.name}]:`, e.message); return []; }
}

async function fetchHadiAPI() {
    if (!Config.hadiAPI || !Config.hadiAPI.enabled) return [];
    try {
        const r = await axios.get(Config.hadiAPI.url, { params:{token:Config.hadiAPI.token}, headers:{'User-Agent':'Mozilla/5.0'}, timeout:10000 });
        if (r.data && (r.data.status === "success" || r.data.status === "Success")) return r.data.data || [];
    } catch(e) { console.log("❌ [Hadi API]:", e.message); }
    return [];
}

let otpCounter = 1;
function getCounterLabel() {
    const s = ["¹","²","³","⁴","⁵","⁶","⁷","⁸","⁹","⁰"];
    const l = s[(otpCounter-1)%10];
    otpCounter++; if (otpCounter>20) otpCounter=1;
    return l;
}

async function sendWhatsAppMessage(rawTime, phone, service, fullMsg, msgId, isBoot, source, user) {
    if (!user || !user.sock || !user.isConnected) return;
    fullMsg = (fullMsg||'').replace(/null/g,'').replace(/(\d)n([^\d\s])/g,'$1 $2').replace(/nDont/g,' Dont').replace(/nDo /g,' Do ').replace(/nYour/g,' Your');
    const flat = fullMsg.replace(/\n/g,' ').replace(/\r/g,'');
    if (!phone || phone==="0" || phone==="Inconnu") return;
    const country = getCountryFromPhone(phone);
    const flag = getCountryFlag(country);
    const otp = extractOTP(flat);
    const masked = maskPhoneNumber(phone);
    const label = getCounterLabel();
    const poweredBy = user.poweredBy || 'Digital Crew 243';
    const numbersChannel = user.numbersChannel || 'https://whatsapp.com/channel/0029VbBT7FdLCoX1TDyQQb1B';
    const mainChannel = user.mainChannel || 'https://whatsapp.com/channel/0029Vb8nTAS9cDDf9NZk1f2m';
    const channelId = user.otpChannel;

    let body = `╭━━━〔 🔐 NOUVELLE ALERTE OTP 〕━━━╮\n`;
    body += `│ 💭 𝗣𝗔𝗡𝗘𝗔𝗨    :: 📞\n`;
    body += `│ 🌍 𝗣𝗔𝗬𝗦   :: *${flag} ${country}*\n`;
    body += `│ 📱 𝗡𝗨𝗠É𝗥𝗢    :: *${masked}*\n`;
    body += `│ 🛠️ 𝗦𝗘𝗥𝗩𝗜𝗖𝗘   :: *${service.toUpperCase()}*\n`;
    body += `│ 🔑 𝗢𝗧𝗣       :: *${otp}*\n`;
    body += `│ 📝 𝗠𝗘𝗦𝗦𝗔𝗚𝗘 𝗖𝗢𝗠𝗣𝗟𝗘𝗧 ::\n*_${flat.substring(0,200)}_*\n`;
    body += `╰━━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
    body += `📢 📲 𝗡𝗢𝗨𝗩𝗘𝗟𝗟𝗘 𝗟𝗜𝗦𝗧𝗘 𝗗𝗘 𝗡𝗨𝗠É𝗥𝗢𝗦 ⚡: ⤵️\n*${numbersChannel}*\n`;
    body += `🧠 𝗖𝗔𝗡𝗔𝗟 𝗣𝗥𝗜𝗡𝗖𝗜𝗣𝗔𝗟✨\n*${mainChannel}*\n\n`;
    body += `> *✦ © ${poweredBy}  ✦*`;
    if (isBoot) body = `🟢 *BOT DÉMARRÉ* 🟢\n\n` + body;

    try {
        await user.sock.sendMessage(channelId, {text: body});
        console.log(`✅ [Envoyé à ${user.phone}] ${masked} (${service}) via ${source}`);
    } catch(e) {
        console.log(`❌ [Envoi à ${user.phone}]:`, e.message);
    }
    markAsSent(msgId, user.phone || 'default');
}

async function checkHadiSMS(user) {
    if (!user || !user.isConnected || !user.otpSources.hadi) return;
    const data = await fetchHadiSMS(user.hadiState);
    if (!data || !data.length) return;
    if (user.isFirstRunHadi) {
        console.log(`🔄 [Hadi-Démarrage Utilisateur:${user.phone}] Mise en cache...`);
        for (let i=0; i < data.length; i++) {
            const row=data[i]; if (!Array.isArray(row) || row.length < 6) continue;
            const msgId=`H_${row[2]}_${row[0]}_${user.phone||'default'}`;
            if (i===0) await sendWhatsAppMessage(row[0],row[2],row[3],row[5],msgId,true,"HADI",user);
            markAsSent(msgId, user.phone || 'default');
        }
        user.isFirstRunHadi=false; console.log(`✅ [Hadi-Démarrage Utilisateur:${user.phone}] ${data.length} mis en cache`); return;
    }
    let newCount=0;
    for (const row of data) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const msgId=`H_${row[2]}_${row[0]}_${user.phone||'default'}`;
        if (!await isAlreadySent(msgId)) { newCount++; await sendWhatsAppMessage(row[0],row[2],row[3],row[5],msgId,false,"HADI",user); }
    }
    if (newCount) console.log(`🆕 [Hadi Utilisateur:${user.phone}] ${newCount} NOUVEAU`);
}

async function checkAPIOTPs(user) {
    if (!user || !user.isConnected || !user.otpSources.api) return;
    const data = await fetchAPIData();
    if (!data || !data.length) return;
    if (user.isFirstRunAPI) {
        console.log(`🔄 [API-Démarrage Utilisateur:${user.phone}] Mise en cache...`);
        for (let i=0; i < data.length; i++) {
            const item=data[i]; const msgId=`API_${item.phone}_${item.time}_${user.phone||'default'}`;
            if (i===0) await sendWhatsAppMessage(item.time,item.phone,item.service,item.message,msgId,true,"API",user);
            markAsSent(msgId, user.phone || 'default');
        }
        user.isFirstRunAPI=false; console.log(`✅ [API-Démarrage Utilisateur:${user.phone}] ${data.length} mis en cache`); return;
    }
    let newCount=0;
    for (const item of data) {
        const msgId=`API_${item.phone}_${item.time}_${user.phone||'default'}`;
        if (!await isAlreadySent(msgId)) { newCount++; await sendWhatsAppMessage(item.time,item.phone,item.service,item.message,msgId,false,"API",user); }
    }
    if (newCount) console.log(`🆕 [API Utilisateur:${user.phone}] ${newCount} NOUVEAU`);
}

async function checkNumberPanelSMS(user) {
    if (!user || !user.isConnected || !user.otpSources.numberPanel) return;
    for (const api of Config.numberPanelAPIs) {
        const state = user.numberPanelStates[api.name];
        if (!state) { user.numberPanelStates[api.name] = {isFirstRun:true}; continue; }
        const data = await fetchNumberPanelSMS(api);
        if (!data || !data.length) continue;
        if (state.isFirstRun) {
            console.log(`🔄 [${api.name}-Démarrage Utilisateur:${user.phone}] Mise en cache...`);
            for (let i=0; i < data.length; i++) {
                const item=data[i]; const msgId=`NP_${api.name}_${item.phone}_${item.time}_${user.phone||'default'}`;
                if (i===0) await sendWhatsAppMessage(item.time,item.phone,item.service,item.message,msgId,true,api.name.toUpperCase(),user);
                markAsSent(msgId, user.phone || 'default');
            }
            state.isFirstRun=false; console.log(`✅ [${api.name}-Démarrage Utilisateur:${user.phone}] ${data.length} mis en cache`); continue;
        }
        let newCount=0;
        for (const item of data) {
            const msgId=`NP_${api.name}_${item.phone}_${item.time}_${user.phone||'default'}`;
            if (!await isAlreadySent(msgId)) { newCount++; await sendWhatsAppMessage(item.time,item.phone,item.service,item.message,msgId,false,api.name.toUpperCase(),user); }
        }
        if (newCount) console.log(`🆕 [${api.name} Utilisateur:${user.phone}] ${newCount} NOUVEAU`);
    }
}

async function checkHadiAPI(user) {
    if (!user || !user.isConnected || !user.otpSources.hadiAPI) return;
    const data = await fetchHadiAPI();
    if (!data || !data.length) return;
    if (user.isFirstRunHadiAPI) {
        console.log(`🔄 [Hadi-API-Démarrage Utilisateur:${user.phone}] Mise en cache...`);
        for (let i=0; i < data.length; i++) {
            const sms=data[i]; const num=sms.num||sms.number||sms.phone||"Inconnu";
            const msg=sms.message||sms.msg||sms.text||""; const dt=sms.dt||sms.datetime||"";
            const msgId=`HAPI_${num}_${dt}_${msg}_${user.phone||'default'}`;
            if (i===0 && msg) await sendWhatsAppMessage(dt,num,detectService(msg),msg,msgId,true,"HADI-API",user);
            markAsSent(msgId, user.phone || 'default');
        }
        user.isFirstRunHadiAPI=false; console.log(`✅ [Hadi-API-Démarrage Utilisateur:${user.phone}] ${data.length} mis en cache`); return;
    }
    let newCount=0;
    for (const sms of data) {
        const num=sms.num||sms.number||sms.phone||"Inconnu";
        const msg=sms.message||sms.msg||sms.text||""; const dt=sms.dt||sms.datetime||"";
        if (!msg) continue; const msgId=`HAPI_${num}_${dt}_${msg}_${user.phone||'default'}`;
        if (!await isAlreadySent(msgId)) { newCount++; await sendWhatsAppMessage(dt,num,detectService(msg),msg,msgId,false,"HADI-API",user); }
    }
    if (newCount) console.log(`🆕 [Hadi-API Utilisateur:${user.phone}] ${newCount} NOUVEAU`);
}

async function checkFlynSMS(user) {
    if (!user || !user.isConnected || !Config.flynSMS || !Config.flynSMS.enabled || !user.otpSources.flyn) return;
    if (!user.flynSession) {
        user.flynSession = new Login1Session({...Config.flynSMS, name: `FLYN-SMS-${user.phone}`});
        await user.flynSession._login();
    }

    const data = await user.flynSession.fetch_data();
    if (!data || !data.aaData || !data.aaData.length) return;

    if (user.isFirstRunFlyn) {
        console.log(`🔄 [FLYN-Démarrage Utilisateur:${user.phone}] Mise en cache...`);
        for (let i=0; i < data.aaData.length; i++) {
            const row=data.aaData[i]; 
            if (!Array.isArray(row) || row.length < 6) continue;
            const msgId=`FLYN_${row[2]}_${row[0]}_${user.phone||'default'}`;
            if (i===0) await sendWhatsAppMessage(row[0],row[2],row[3]||'SMS',row[5],msgId,true,"FLYN",user);
            markAsSent(msgId, user.phone || 'default');
        }
        user.isFirstRunFlyn=false; console.log(`✅ [FLYN-Démarrage Utilisateur:${user.phone}] ${data.aaData.length} mis en cache`); return;
    }

    let newCount=0;
    for (const row of data.aaData) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const msgId=`FLYN_${row[2]}_${row[0]}_${user.phone||'default'}`;
        if (!await isAlreadySent(msgId)) { 
            newCount++; 
            await sendWhatsAppMessage(row[0],row[2],row[3]||'SMS',row[5],msgId,false,"FLYN",user); 
        }
    }
    if (newCount) console.log(`🆕 [FLYN Utilisateur:${user.phone}] ${newCount} NOUVEAU`);
}

async function checkNumberPanelLogin(user) {
    if (!user || !user.isConnected || !Config.numberPanelLogin || !Config.numberPanelLogin.enabled || !user.otpSources.numberPanelLogin) return;
    if (!user.numberPanelSession) {
        user.numberPanelSession = new Login1Session({...Config.numberPanelLogin, name: `NUMBERS-PANEL-${user.phone}`});
        await user.numberPanelSession._login();
    }

    const data = await user.numberPanelSession.fetch_data();
    if (!data || !data.aaData || !data.aaData.length) return;

    if (user.isFirstRunNumberPanel) {
        console.log(`🔄 [NumberPanel-Démarrage Utilisateur:${user.phone}] Mise en cache...`);
        for (let i=0; i < data.aaData.length; i++) {
            const row=data.aaData[i]; 
            if (!Array.isArray(row) || row.length < 6) continue;
            const msgId=`NPLOGIN_${row[2]}_${row[0]}_${user.phone||'default'}`;
            if (i===0) await sendWhatsAppMessage(row[0],row[2],row[3]||'SMS',row[5],msgId,true,"NUMBER",user);
            markAsSent(msgId, user.phone || 'default');
        }
        user.isFirstRunNumberPanel=false; console.log(`✅ [NumberPanel-Démarrage Utilisateur:${user.phone}] ${data.aaData.length} mis en cache`); return;
    }

    let newCount=0;
    for (const row of data.aaData) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const msgId=`NPLOGIN_${row[2]}_${row[0]}_${user.phone||'default'}`;
        if (!await isAlreadySent(msgId)) { 
            newCount++; 
            await sendWhatsAppMessage(row[0],row[2],row[3]||'SMS',row[5],msgId,false,"NUMBER",user); 
        }
    }
    if (newCount) console.log(`🆕 [NumberPanel Utilisateur:${user.phone}] ${newCount} NOUVEAU`);
}

async function startUserWhatsAppPairing(userId, phone, chatId) {
    const user = getUser(userId);
    if (user.isConnecting) return;

    if (user.sock) {
        try {
            user.sock.ev.removeAllListeners();
            user.sock.ws?.close();
        } catch(e) {}
        user.sock = null;
    }

    user.isConnecting = true;

    const authDir = path.join(__dirname, 'auth', userId);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    try {
        console.log(`\n🚀 Démarrage de WhatsApp pour l'utilisateur ${userId}...`);
        console.log('📱 Cible:', phone);

        user.reconnectAttempts++;
        if (user.reconnectAttempts > 100) user.reconnectAttempts = 1;
        console.log(`🔄 Tentative ${user.reconnectAttempts}`);

        const {state, saveCreds} = await useMultiFileAuthState(authDir);
        const {version} = await fetchLatestBaileysVersion();
        const browsers = [
            ["Ubuntu", "Chrome", "120.0.0.0"],
            ["Ubuntu", "Firefox", "121.0"],
            ["Linux", "Chrome", "119.0.0.0"],
            ["Ubuntu", "Edge", "120.0.0"]
        ];
        const browser = browsers[user.reconnectAttempts % browsers.length];

        user.sock = makeWASocket({
            version, 
            printQRInTerminal: false, 
            logger: P({level: "fatal"}),
            connectTimeoutMs: 60000, 
            keepAliveIntervalMs: 30000,
            browser: browser,
            auth: state,
            markOnlineOnConnect: false,
            syncFullHistory: false, 
            defaultQueryTimeoutMs: 60000,
            getMessage: async () => undefined,
            generateHighQualityLinkPreview: false,
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 1,
            fireInitQueries: true,
            shouldIgnoreJid: () => false
        });

        user.sock.ev.on("connection.update", async (update) => {
            const {connection, lastDisconnect} = update;
            if (connection === "close") {
                const wasConnected = user.isConnected;
                user.isConnected = false; 
                user.isConnecting = false;

                if (user.sock) {
                    try { 
                        user.sock.ev.removeAllListeners(); 
                        user.sock.ws?.close(); 
                    } catch(e) {}
                    user.sock = null;
                }

                if (!fs.existsSync(authDir)) {
                    console.log(`🔴 Utilisateur ${userId} déconnecté manuellement. Pas de reconnexion.`);
                    user.pairingCodeSent = false;
                    user.reconnectAttempts = 0;
                    return;
                }

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                const isBadSession = statusCode === DisconnectReason.badSession || statusCode === 500;

                const maxRetries = 5;
                const shouldDeleteAuth = isLoggedOut || isBadSession || user.reconnectAttempts >= maxRetries;

                if (shouldDeleteAuth) {
                    console.log(`🔴 Utilisateur ${userId} auth INVALIDE (code:${statusCode}, tentatives:${user.reconnectAttempts}). SUPPRESSION de l'auth...`);

                    try {
                        if (fs.existsSync(authDir)) {
                            fs.rmSync(authDir, { recursive: true, force: true });
                            console.log(`🗑️ Auth supprimée pour ${userId}`);
                        }
                    } catch(e) { console.log('❌ Erreur de suppression auth:', e.message); }

                    user.reconnectAttempts = 0;
                    user.pairingCodeSent = false;

                    try {
                        if (user.phone && chatId) {
                            await sendLogoutNotification(chatId, user.phone);
                        }
                    } catch(e) {}
                    return;
                }

                console.log(`⏳ Utilisateur ${userId} déconnecté (${statusCode}), reconnexion... (tentative ${user.reconnectAttempts}/${maxRetries})`);

                const delay = Math.min(10000 * user.reconnectAttempts, 60000);
                console.log(`🔄 Utilisateur ${userId} reconnexion dans ${delay/1000}s...`);

                setTimeout(() => {
                    user.isConnecting = false;
                    startUserWhatsAppPairing(userId, phone, chatId);
                }, delay);

            } else if (connection === "open") {
                console.log(`✅ WhatsApp connecté pour l'utilisateur ${userId}!`);
                user.isConnected = true; 
                user.isConnecting = false; 
                user.reconnectAttempts = 0;
                user.pairingCodeSent = false;
                onUserWhatsAppConnected(userId, chatId);
            }
        });
        user.sock.ev.on("creds.update", saveCreds);

        setTimeout(async () => {
            if (user.isConnected || user.pairingCodeSent || !user.sock || user.isConnecting === false) {
                return;
            }
            if (!user.isConnected && !user.pairingCodeSent && user.sock) {
                try {
                    user.pairingCodeSent = true;
                    const pairingCode = await user.sock.requestPairingCode(phone);
                    const formatted = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
                    fs.writeFileSync(`pairing_code_${userId}.txt`, `Code d'association: ${formatted}\nGénéré: ${new Date().toLocaleString()}\nTéléphone: +${phone}`);
                    await sendTelegramMessage(chatId,
                        `📱 <b>Code d'association WhatsApp</b>\n\n` +
                        `📱 Téléphone: +${phone}\n` +
                        `🔑 Code: <code>${formatted}</code>\n\n` +
                        `⏰ Heure: ${new Date().toLocaleString()}\n\n` +
                        `📲 Ouvrez WhatsApp -> Appareils liés -> Lier un appareil -> Lier avec le numéro de téléphone`
                    );
                    console.log(`✅ CODE D'ASSOCIATION PRÊT pour ${userId}!`);
                    console.log(`📱 Téléphone: +${phone}`);
                    console.log(`🔑 Code: ${formatted}`);
                } catch(err) {
                    console.log('❌ Erreur d\'association:', err.message);
                    user.pairingCodeSent = false;
                    await sendTelegramMessage(chatId, `❌ Échec de l'association: ${err.message}`);
                }
            }
        }, 15000);
    } catch(error) {
        console.error('❌ Erreur:', error.message);
        user.isConnecting = false;
        user.pairingCodeSent = false;
        await sendTelegramMessage(chatId, `❌ Erreur: ${error.message}`);
    }
}

function onUserWhatsAppConnected(userId, chatId) {
    const user = getUser(userId);
    console.log(`\n✅ WHATSAPP CONNECTÉ pour ${userId}!`);
    console.log(`👤 Utilisateur: ${user.sock.user.id}`);

    if (Config.numberPanelAPIs) Config.numberPanelAPIs.forEach(api => {
        if (!user.numberPanelStates[api.name]) user.numberPanelStates[api.name] = {isFirstRun:true};
    });

setTimeout(async () => {
    try {
        await user.sock.sendMessage(user.otpChannel, {
            text: `🤖 BOT OTP VIP CONNECTÉ ✅\n\n🧪MESSAGE DE TEST\n\n📡 Surveillance: Multi‑Panneau en Direct\n🔒 Mode: VIP Lourd / Ultra Sécurisé\n⚡ Statut: Capture d'OTP en Temps Réel Active\n✨ Disponibilité: 24/7 Dédié\n\n> 👤 Propulsé par ${user.poweredBy || 'Digital Crew 243'}`
        });
        console.log(`✅ Message de test envoyé pour ${userId}`);
    } catch(e) { console.log(`❌ Échec du test pour ${userId}:`, e.message); }
}, 5000);

    sendTelegramMessage(chatId, `✅ <b>WhatsApp Connecté!</b>\n\nVos OTP seront maintenant transférés vers:\n${user.otpChannel}`);
}

function startGlobalMonitoring() {
    console.log('\n🚀 Démarrage des moniteurs globaux...\n');
    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (!user.isConnected) continue;
            try { await checkHadiSMS(user); } catch(e) {}
        }
    }, Config.interval);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (!user.isConnected) continue;
            try { await checkAPIOTPs(user); } catch(e) {}
        }
    }, Config.interval);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (!user.isConnected) continue;
            try { await checkNumberPanelSMS(user); } catch(e) {}
        }
    }, Config.interval);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (!user.isConnected) continue;
            try { await checkHadiAPI(user); } catch(e) {}
        }
    }, Config.interval);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (!user.isConnected) continue;
            try { await checkFlynSMS(user); } catch(e) {}
        }
    }, Config.interval);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (!user.isConnected) continue;
            try { await checkNumberPanelLogin(user); } catch(e) {}
        }
    }, Config.interval);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (user.flynSession) { user.flynSession.logged_in = false; await user.flynSession._login(); }
        }
    }, 120000);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (user.numberPanelSession) { user.numberPanelSession.logged_in = false; await user.numberPanelSession._login(); }
        }
    }, 120000);

    setInterval(async () => {
        for (const [userId, user] of Object.entries(users)) {
            if (user.hadismsSession) { user.hadismsSession.logged_in = false; await user.hadismsSession._login(); }
        }
    }, 120000);
}

function startTelegramPolling() {
    console.log('🤖 Bot Telegram démarré...');
    setInterval(() => getTelegramUpdates(), 2000);
}

async function main() {
    console.log('\n🚀 Démarrage...\n');
    console.log('▬▬▬▬▬▬▬▬▬▬▬▬▬▬');
    console.log('🤖 Digital Crew OTP - Bot 2.0 (Multi-Utilisateur + Telegram)');
    console.log('▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n');

    await initDatabase();
    await loadUsersFromDB();

    const globalHadiState = { cookie: null, sessKey: null, isLoggingIn: false };
    await hadiLogin(globalHadiState);
    setInterval(() => hadiLogin(globalHadiState), 120000);

    for (const [userId, user] of Object.entries(users)) {
        if (user.phone && user.otpChannel) {
            console.log(`🔄 Reconnexion de l'utilisateur ${userId}...`);
            await startUserWhatsAppPairing(userId, user.phone, Config.telegramNotify.adminId);
        }
    }

    startTelegramPolling();
    startGlobalMonitoring();

    process.on('SIGINT', async () => {
        console.log('\n🛑 Arrêt en cours...');
        for (const user of Object.values(users)) {
            if (user.sock) try { user.sock.end(); } catch(e) {}
        }
        if (db) db.close();
        process.exit(0);
    });
}
main().catch(console.error);