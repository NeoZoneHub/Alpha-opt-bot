
<div align="center">
  <img src="https://files.catbox.moe/82agzs.jpg" alt="Alpha Opt Bot" width="200"/>
  
  # 🔐 Alpha Opt Bot
  
  [![Telegram](https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/)
  [![WhatsApp](https://img.shields.io/badge/WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://wa.me/)
  [![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  
  <p align="center">
    <b>Bot Telegram pour la gestion des codes OTP WhatsApp</b>
  </p>
  
  [![Deploy on Katabump](https://img.shields.io/badge/DEPLOY_ON_KATABUMP-ff6b6b?style=for-the-badge&logo=rocket&logoColor=white)](https://rl.katabump.fr/efa16b)
</div>

---

## ✨ Fonctionnalités

- 🤖 **Gestion des codes OTP** - Envoie automatiquement des codes dans les chaînes WhatsApp
- 📢 **Multi-chaînes** - Gérez plusieurs chaînes simultanément
- 🔐 **Sécurisé** - Authentification par session
- 🚀 **Déploiement facile** - Compatible avec Katabump et autres panels
- ⚡ **Rapide et fiable** - Optimisé pour les envois massifs

---

## 📋 Prérequis

- Node.js (v18 ou supérieur)
- Compte Telegram (pour le bot)
- Compte WhatsApp

---

## 🚀 Installation

### 1. Clonez le repository

```bash
git clone https://github.com/NeoZoneHub/Alpha-opt-bot.git
cd Alpha-opt-bot
```

2. Installez les dépendances

```bash
npm install
```

3. Lancez le bot

```bash
node index.js
```

---

🔧 Configuration

Fichier config.js

```javascript
module.exports = {
    Config: {
        ownerNumber: "92",
        botName: "Alpha OTP",
        otpChannelIDs: ["@DigitalCrewNew"],
        joinLink: "https://whatsapp.com/channel/0029VbBT7FdLCoX1TDyQQb1B",
        interval: 5000,

        telegramNotify: {
            enabled: true,
            botToken: "8920375821:AAFnfbRBaPw7FzPp3VYNfRCFdSqkb5kYoD4",
            adminId: "6139517534"
        }
    }
};
```
---

📦 Déploiement sur Katabump

1. Connectez-vous à votre panel Katabump
2. Cliquez sur le bouton ci-dessous :
   <a href="https://rl.katabump.fr/efa16b">
        <img src="https://img.shields.io/badge/DÉPLOYER_SUR_KATABUMP-FF6B6B?style=for-the-badge&logo=rocket&logoColor=white&fontSize=20" alt="Deploy on Katabump"/>
      </a>
3. Votre bot sera en ligne en quelques minutes !

---

🛠️ Structure du Projet

```
alpha-opt-bot/
├── 📄 index.js              # Fichier principal
├── 📄 config.js             # Configuration du bot
├── 📄 flag.js               # Flags 
└── 📄 package.json          # Dépendances
```

---

👨‍💻 Crédits

<div align="center">

Réalisé par

  <img src="https://i.imgur.com/digix-logo.png" alt="Digital Crew 243" width="150"/>

DIGITAL CREW 243 🚀

  <p>
    <i>"Always Forward. Digital Crew, one of the best."</i>
  </p>

https://img.shields.io/badge/GitHub-100000?style=for-the-badge&logo=github&logoColor=white

</div>

---

📝 Licence

Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.

---

🙏 Support

Pour toute question ou assistance :

<div align="center">

  <a href="https://wa.me/998771529519">
    <img src="https://img.shields.io/badge/CONTACT_PREMIUM-25D366?style=for-the-badge&logo=whatsapp&logoColor=white&labelColor=128C7E&color=25D366&fontSize=20" alt="Contact Premium" width="300"/>
  </a>

  <br/>
  <br/>

  <img src="https://img.shields.io/badge/⭐_SUPPORT_PREMIUM_⭐-FFD700?style=for-the-badge&logo=star&logoColor=black" alt="Premium Support"/>

</div>

---

<div align="center">

<b>Made with ❤️ by Digital Crew 243</b>

  <p>© 2026 Alpha Opt Bot. Tous droits réservés.</p>

</div>
```