/**
 * SKash WhatsApp Automator - WhatsApp Service
 * This service handles WhatsApp connection and messaging
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 5001;

// Setup CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5000'];

app.use(cors({
  origin: function(origin, callback) {
    // allow requests with no origin (like mobile apps, curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token == null) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication token is required' 
    });
  }
  
  if (token !== process.env.API_TOKEN) {
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid authentication token' 
    });
  }
  
  next();
};

// WhatsApp Client Setup
let whatsappClient = null;
let qrCodeData = null;
let clientStatus = 'disconnected'; // disconnected, connecting, connected

// Function to initialize WhatsApp client
const initWhatsAppClient = () => {
  // Create session directory if it doesn't exist
  const sessionDir = process.env.SESSION_DATA_PATH || './session-data';
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  
  console.log('Initializing WhatsApp client...');
  clientStatus = 'connecting';
  
  // Initialize the client
  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: sessionDir
    }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });
  
  // Event handlers
  whatsappClient.on('qr', (qr) => {
    console.log('QR Code received');
    qrCodeData = qr;
  });
  
  whatsappClient.on('authenticated', () => {
    console.log('WhatsApp authenticated');
    qrCodeData = null;
  });
  
  whatsappClient.on('auth_failure', (err) => {
    console.error('WhatsApp authentication failed:', err);
    clientStatus = 'disconnected';
  });
  
  whatsappClient.on('ready', () => {
    console.log('WhatsApp client is ready');
    clientStatus = 'connected';
    qrCodeData = null;
  });
  
  whatsappClient.on('disconnected', (reason) => {
    console.log('WhatsApp client disconnected:', reason);
    clientStatus = 'disconnected';
    whatsappClient = null;
    
    // Attempt to reinitialize after a delay
    setTimeout(() => {
      if (clientStatus === 'disconnected') {
        initWhatsAppClient();
      }
    }, 5000);
  });
  
  // Initialize the client
  whatsappClient.initialize();
};

// Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'ok', 
    service: 'skash-whatsapp-service',
    version: '1.0.0'
  });
});

// Get WhatsApp connection status
app.get('/api/status', authenticateToken, (req, res) => {
  if (!whatsappClient) {
    return res.json({
      success: false,
      active: false,
      message: 'WhatsApp client not initialized'
    });
  }
  
  res.json({
    success: true,
    active: clientStatus === 'connected',
    status: clientStatus,
    info: clientStatus === 'connected' ? {
      name: whatsappClient.info.wid.user,
      phone: whatsappClient.info.wid.user
    } : null
  });
});

// Get QR code for WhatsApp authentication
app.get('/api/qrcode', authenticateToken, async (req, res) => {
  if (clientStatus === 'connected') {
    return res.json({
      success: true,
      active: true,
      message: 'WhatsApp is already connected'
    });
  }
  
  if (!whatsappClient) {
    initWhatsAppClient();
    
    return res.json({
      success: false,
      message: 'WhatsApp client is initializing, please try again in a few seconds'
    });
  }
  
  if (!qrCodeData) {
    return res.json({
      success: false,
      message: 'QR code not yet available, please try again in a few seconds'
    });
  }
  
  try {
    // Generate QR code as data URL
    const qrCodeImage = await qrcode.toDataURL(qrCodeData);
    
    res.json({
      success: true,
      qrCode: `<img src="${qrCodeImage}" alt="WhatsApp QR Code" />`,
      qrCodeData: qrCodeData
    });
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate QR code: ' + error.message
    });
  }
});

// Logout/disconnect WhatsApp
app.post('/api/logout', authenticateToken, async (req, res) => {
  if (!whatsappClient) {
    return res.json({
      success: false,
      message: 'WhatsApp client not initialized'
    });
  }
  
  try {
    // Log out WhatsApp
    await whatsappClient.logout();
    
    // Reset client
    whatsappClient = null;
    clientStatus = 'disconnected';
    qrCodeData = null;
    
    res.json({
      success: true,
      message: 'WhatsApp logged out successfully'
    });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to logout: ' + error.message
    });
  }
});

// Send WhatsApp message
app.post('/api/send', authenticateToken, async (req, res) => {
  if (!whatsappClient || clientStatus !== 'connected') {
    return res.status(400).json({
      success: false,
      message: 'WhatsApp is not connected'
    });
  }
  
  const { phone, message, media_url, media_type, caption } = req.body;
  
  if (!phone || (!message && !media_url)) {
    return res.status(400).json({
      success: false,
      message: 'Phone number and either message or media_url are required'
    });
  }
  
  // Format phone number to WhatsApp format (remove + and add @c.us)
  const formattedPhone = phone.replace(/\D/g, '') + '@c.us';
  
  try {
    let messageId = null;
    
    // Send message based on type
    if (media_url) {
      const mediaData = await fetchMedia(media_url);
      
      if (!mediaData) {
        return res.status(400).json({
          success: false,
          message: 'Failed to fetch media from URL'
        });
      }
      
      let sentMessage;
      
      switch (media_type) {
        case 'image':
          sentMessage = await whatsappClient.sendMessage(
            formattedPhone, 
            mediaData, 
            { caption: caption || message }
          );
          break;
          
        case 'document':
          sentMessage = await whatsappClient.sendMessage(
            formattedPhone, 
            mediaData, 
            { caption: caption || message }
          );
          break;
          
        case 'audio':
          sentMessage = await whatsappClient.sendMessage(
            formattedPhone, 
            mediaData
          );
          break;
          
        case 'video':
          sentMessage = await whatsappClient.sendMessage(
            formattedPhone, 
            mediaData, 
            { caption: caption || message }
          );
          break;
          
        default:
          // If media type not specified, try to send as image
          sentMessage = await whatsappClient.sendMessage(
            formattedPhone, 
            mediaData, 
            { caption: caption || message }
          );
      }
      
      messageId = sentMessage.id._serialized;
    } else {
      // Send text message
      const sentMessage = await whatsappClient.sendMessage(formattedPhone, message);
      messageId = sentMessage.id._serialized;
    }
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      message_id: messageId,
      phone: phone,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message: ' + error.message
    });
  }
});

// Fetch media from URL
async function fetchMedia(url) {
  try {
    const fetch = await import('node-fetch');
    
    const response = await fetch.default(url);
    
    if (!response.ok) {
      console.error(`Error fetching media: ${response.status} ${response.statusText}`);
      return null;
    }
    
    const buffer = await response.buffer();
    
    // Get media info from URL or response headers
    const contentType = response.headers.get('content-type');
    const fileExtension = getExtensionFromMimeType(contentType) || getExtensionFromUrl(url);
    
    return {
      mimetype: contentType,
      data: buffer,
      filename: `media_${Date.now()}.${fileExtension}`
    };
  } catch (error) {
    console.error('Error fetching media:', error);
    return null;
  }
}

// Get file extension from MIME type
function getExtensionFromMimeType(mimeType) {
  if (!mimeType) return null;
  
  const mimeToExt = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf'
  };
  
  return mimeToExt[mimeType] || null;
}

// Get file extension from URL
function getExtensionFromUrl(url) {
  if (!url) return 'unknown';
  
  const match = url.match(/\.([a-zA-Z0-9]+)(\?|#|$)/);
  return match ? match[1].toLowerCase() : 'unknown';
}

// Get contacts
app.get('/api/contacts', authenticateToken, async (req, res) => {
  if (!whatsappClient || clientStatus !== 'connected') {
    return res.status(400).json({
      success: false,
      message: 'WhatsApp is not connected'
    });
  }
  
  try {
    const contacts = await whatsappClient.getContacts();
    
    // Filter and format contacts
    const formattedContacts = contacts
      .filter(contact => !contact.isMe && !contact.isGroup && !contact.isWAContact)
      .map(contact => ({
        id: contact.id._serialized,
        name: contact.name || contact.pushname || 'Unknown',
        number: contact.number,
        isGroup: contact.isGroup,
        isBlocked: contact.isBlocked
      }));
    
    res.json({
      success: true,
      contacts: formattedContacts
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch contacts: ' + error.message
    });
  }
});

// Get groups
app.get('/api/groups', authenticateToken, async (req, res) => {
  if (!whatsappClient || clientStatus !== 'connected') {
    return res.status(400).json({
      success: false,
      message: 'WhatsApp is not connected'
    });
  }
  
  try {
    const chats = await whatsappClient.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    
    // Format groups
    const formattedGroups = groups.map(group => ({
      id: group.id._serialized,
      name: group.name,
      participants: group.participants?.length || 0,
      isGroup: true
    }));
    
    res.json({
      success: true,
      groups: formattedGroups
    });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch groups: ' + error.message
    });
  }
});

// Get group members
app.get('/api/groups/:groupId/members', authenticateToken, async (req, res) => {
  if (!whatsappClient || clientStatus !== 'connected') {
    return res.status(400).json({
      success: false,
      message: 'WhatsApp is not connected'
    });
  }
  
  const { groupId } = req.params;
  
  try {
    const chat = await whatsappClient.getChatById(groupId);
    
    if (!chat || !chat.isGroup) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    // Get participants
    const participants = await chat.participants;
    
    // Format participants
    const formattedParticipants = await Promise.all(participants.map(async participant => {
      const contact = await whatsappClient.getContactById(participant.id._serialized);
      
      return {
        id: participant.id._serialized,
        name: contact.name || contact.pushname || 'Unknown',
        number: contact.number,
        isAdmin: participant.isAdmin || false
      };
    }));
    
    res.json({
      success: true,
      group: {
        id: chat.id._serialized,
        name: chat.name
      },
      members: formattedParticipants
    });
  } catch (error) {
    console.error('Error fetching group members:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch group members: ' + error.message
    });
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp service running on http://0.0.0.0:${PORT}`);
  
  // Initialize WhatsApp client
  initWhatsAppClient();
});