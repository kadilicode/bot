const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// 🌟 SECURE FIREBASE URL FROM GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {}; 

// Function to fetch the dynamic menu from your App's Firebase
async function getMenuFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await response.json();
        if (!data) return[];
        
        // Convert Firebase object into an array (now includes imageUrl)
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl
        }));
    } catch (error) {
        console.error("Failed to fetch menu:", error);
        return[];
    }
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser:["S", "K", "1"] 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear(); 
            console.log('\n==================================================');
            console.log('⚠️ QR CODE TOO BIG? CLICK "View raw logs" in top right!');
            console.log('==================================================\n');
            qrcode.generate(qr, { small: true }); 
        }

        if (connection === 'open') console.log('✅ KADILIBOTSHOP BOT INAENDESHA!');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return; // Loop Protection

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        console.log(`📩 Query: ${text}`);

        // --- 🛒 STEP 2: FINISH ORDER & SEND TO ADMIN PANEL ---
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const customerDetails = text; // This now contains Name, Phone, and Address
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];

            // Match the exact format of your Kadilibotshop Admin Panel
            const kadilibotOrder = {
                userId: "whatsapp_" + customerWaNumber,
                userEmail: "whatsapp@kadilibotshop.com",
                phone: customerWaNumber, // Keeps their WA number registered
                address: customerDetails, // Saves Name, Phone, and Address typed by them
                location: { lat: 0, lng: 0 },
                items:[{
                    id: item.id,
                    name: item.name,
                    price: parseFloat(item.price),
                    img: item.imageUrl || "",
                    quantity: 1
                }],
                total: (parseFloat(item.price) + 50).toFixed(2), // Bei + Tsh 50 Ada ya Uwasilishaji
                status: "Imeagizwa",
                method: "Lipa Ukipokea (WhatsApp)",
                timestamp: new Date().toISOString()
            };

            // Save order securely via REST API
            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(kadilibotOrder)
                });
            } catch (error) {
                console.log("Firebase Error: ", error);
            }

            await sock.sendMessage(sender, { text: `✅ *Agizo Limepokewa!* \n\nAsante! Agizo lako la *${item.name}* linaandaliwa. \n\n*Jumla:* Tsh${kadilibotOrder.total} (Pamoja na Uwasilishaji)\n*Hali:* Inaandaliwa\n\nTutawasilisha kwa anwani yako hivi karibuni.` });
            delete orderStates[sender]; 
            return;
        }

        // --- 🌟 STEP 1: START ORDER FLOW (WITH IMAGE & PHONE REQUEST) ---
        if (text.startsWith("order ")) {
            const productRequested = text.replace("order ", "").trim().toLowerCase();
            const currentMenu = await getMenuFromApp();
            
            // Search the live database for the requested item
            const matchedItem = currentMenu.find(item => item.name.toLowerCase().includes(productRequested));

            if (!matchedItem) {
                await sock.sendMessage(sender, { text: `❌ Samahani, hatukupata *${productRequested}* katika orodha yetu leo.\n\nAndika *menu* kuona vyakula vyote vilivyopo.` });
                return;
            }

            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: matchedItem };
            
            // 🌟 NEW: SEND PRODUCT IMAGE + ASK FOR PHONE NUMBER 🌟
            const captionText = `🛒 *Agizo Limeanza!* \n\nUmechagua: *${matchedItem.name}* (Tsh ${matchedItem.price})\n\nTafadhali jibu na *Jina Kamili, Nambari ya Simu, na Anwani ya Uwasilishaji*.`;
            
            // If the product has an image URL in Firebase, send it as a WhatsApp Photo
            if (matchedItem.imageUrl) {
                await sock.sendMessage(sender, { 
                    image: { url: matchedItem.imageUrl }, 
                    caption: captionText 
                });
            } else {
                // Fallback if no image is found
                await sock.sendMessage(sender, { text: captionText });
            }
        }
        else if (text === "order") { 
            await sock.sendMessage(sender, { text: "🛒 *Jinsi ya kuagiza:* \nTafadhali andika 'order' kisha jina la chakula. \nMfano: *order piza*" });
        }
        
        // --- DYNAMIC MENU FEATURE ---
        else if (text.includes("menu") || text.includes("price") || text.includes("list") || text.includes("food")) {
            const currentMenu = await getMenuFromApp();
            
            if (currentMenu.length === 0) {
                await sock.sendMessage(sender, { text: "Orodha yetu iko tupu au inasasishwa. Tafadhali angalia baadaye!" });
                return;
            }

            let menuMessage = "🍔 *KADILIBOTSHOP - ORODHA YA VYAKULA* 🍕\n\n";
            currentMenu.forEach(item => {
                menuMessage += `🔸 *${item.name}* - Tsh ${item.price}\n`;
            });
            menuMessage += "\n_Kuagiza, jibu na 'order [jina la chakula]'_";
            
            await sock.sendMessage(sender, { text: menuMessage });
        }

        // --- GREETINGS ---
        else if (text.includes("hi") || text.includes("hello") || text.includes("hey")) {
            await sock.sendMessage(sender, { text: "👋 *Karibu Kadilibotshop!* \n\nMimi ni Msaidizi wako wa AI. Andika *menu* kuona vyakula vyetu, au andika *order [chakula]* kuagiza mara moja!" });
        }
        else if (text.includes("contact") || text.includes("call")) {
            await sock.sendMessage(sender, { text: "📞 *Wasiliana na Kadilibotshop:* \n\n- *Email:* support@kadilibotshop.com" });
        }
        else {
            await sock.sendMessage(sender, { text: "🤔 Sijaelewa vizile.\n\nAndika *menu* kuona orodha ya vyakula, au *order [chakula]* kuagiza!" });
        }
    });
}

startBot().catch(err => console.log("Error: " + err));
