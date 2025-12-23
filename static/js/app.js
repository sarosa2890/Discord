// Discord Clone - Main Application JavaScript

class DiscordApp {
    constructor() {
        this.socket = null;
        this.currentUser = null;
        this.servers = [];
        this.currentServer = null;
        this.currentChannel = null;
        this.currentDM = null;
        this.messages = [];
        this.typingUsers = new Set();
        this.typingTimeout = null;
        this.selectedChannelType = 'text';
        this.replyToMessage = null;
        this.attachments = [];
        this.emojiPickerVisible = false;
        this.webrtcManager = null;
        this.friends = [];
        this.friendRequests = [];
        this.incomingCall = null;
        this.reactingToMessage = null;
        
        this.init();
    }
    
    async init() {
        // Убеждаемся, что модальное окно настроек закрыто
        this.closeModal();
        
        await this.loadUser();
        this.initSocket();
        await this.loadServers();
        this.setupEventListeners();
        this.initWebRTC();
        await this.loadFriends();
        await this.loadFriendRequests();
        this.showDMs();
    }
    
    initWebRTC() {
        if (window.WebRTCManager && this.socket) {
            this.webrtcManager = new WebRTCManager(this.socket);
            window.webrtcManager = this.webrtcManager;
            
            // Обработка входящих звонков
            this.socket.on('webrtc_offer', (data) => {
                this.handleIncomingCall(data);
            });
            
            this.socket.on('webrtc_answer', (data) => {
                if (this.webrtcManager) {
                    this.webrtcManager.handleAnswer(data);
                }
            });
            
            this.socket.on('webrtc_ice_candidate', (data) => {
                if (this.webrtcManager) {
                    this.webrtcManager.handleIceCandidate(data);
                }
            });
            
            this.socket.on('webrtc_end_call', (data) => {
                this.endCall();
            });
        }
    }
    
    async loadFriends() {
        try {
            const response = await fetch('/api/friends');
            if (response.ok) {
                this.friends = await response.json();
            }
        } catch (error) {
            console.error('Error loading friends:', error);
        }
    }
    
    async loadFriendRequests() {
        try {
            const response = await fetch('/api/friends/requests');
            if (response.ok) {
                this.friendRequests = await response.json();
            }
        } catch (error) {
            console.error('Error loading friend requests:', error);
        }
    }
    
    async loadUser() {
        try {
            const response = await fetch('/api/user');
            if (response.ok) {
                this.currentUser = await response.json();
                this.updateUserPanel();
                this.checkEmailVerification();
            }
        } catch (error) {
            console.error('Error loading user:', error);
        }
    }
    
    checkEmailVerification() {
        if (this.currentUser && !this.currentUser.email_verified) {
            const banner = document.getElementById('email-verification-banner');
            if (banner) {
                banner.style.display = 'flex';
            }
        } else {
            const banner = document.getElementById('email-verification-banner');
            if (banner) {
                banner.style.display = 'none';
            }
        }
    }
    
    closeEmailBanner() {
        const banner = document.getElementById('email-verification-banner');
        if (banner) {
            banner.style.display = 'none';
        }
    }
    
    initSocket() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('Connected to server');
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
        });
        
        this.socket.on('new_message', (message) => {
            if (this.currentChannel && message.channel_id === this.currentChannel.id) {
                this.addMessage(message);
            }
        });
        
        this.socket.on('message_updated', (message) => {
            this.updateMessage(message);
        });
        
        this.socket.on('message_deleted', (data) => {
            this.removeMessage(data.id);
        });
        
        this.socket.on('user_typing', (data) => {
            this.showTyping(data.user);
        });
        
        this.socket.on('user_stop_typing', (data) => {
            this.hideTyping(data.user_id);
        });
        
        this.socket.on('user_online', (user) => {
            this.updateUserStatus(user.id, 'online');
        });
        
        this.socket.on('user_offline', (data) => {
            this.updateUserStatus(data.id, 'offline');
        });
        
        this.socket.on('user_status_update', (data) => {
            this.updateUserStatus(data.user_id, data.status);
        });
        
        this.socket.on('channel_created', (channel) => {
            if (this.currentServer && channel.server_id === this.currentServer.id) {
                this.loadChannels();
            }
        });
        
        this.socket.on('channel_deleted', (data) => {
            if (this.currentChannel && this.currentChannel.id === data.id) {
                this.currentChannel = null;
                this.showWelcomeMessage();
            }
            if (this.currentServer) {
                this.loadChannels();
            }
        });
        
        this.socket.on('new_dm', (dm) => {
            if (this.currentDM && 
                ((dm.sender.id === this.currentDM.id && dm.receiver.id === this.currentUser.id) ||
                 (dm.receiver.id === this.currentDM.id && dm.sender.id === this.currentUser.id))) {
                // Add to messages array
                const message = {
                    id: dm.id,
                    content: dm.content,
                    author: dm.sender.id === this.currentUser.id ? this.currentUser : dm.sender,
                    created_at: dm.created_at,
                    channel_id: null
                };
                if (!this.messages.find(m => m.id === message.id)) {
                    this.messages.push(message);
                }
                this.addMessage(message);
            } else {
                // Показываем уведомление о новом сообщении
                this.showNotification(`Новое сообщение от ${dm.sender.username}`, 'info');
                this.playSound('message');
            }
        });
        
        this.socket.on('voice_state_update', (data) => {
            // Handle voice channel updates
            console.log('Voice state update:', data);
        });
    }
    
    setupEventListeners() {
        // Message input
        const messageInput = document.getElementById('message-input');
        if (messageInput) {
            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
            
            messageInput.addEventListener('input', () => {
                this.handleTyping();
                this.autoResizeTextarea(messageInput);
            });
        }
        
        // File input
        const fileInput = document.getElementById('file-input');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        }
        
        // Modal overlay
        const modalOverlay = document.getElementById('modal-overlay');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) {
                    this.closeModal();
                }
            });
        }
        
        // Settings navigation
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.addEventListener('click', () => {
                const section = item.dataset.section;
                if (section) {
                    this.showSettingsSection(section);
                }
            });
        });
        
        // Context menu
        document.addEventListener('click', () => {
            this.hideContextMenu();
        });
        
        // Emoji picker
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.emoji-picker') && !e.target.closest('.emoji-btn')) {
                this.hideEmojiPicker();
            }
        });
    }
    
    updateUserPanel() {
        if (!this.currentUser) return;
        
        const avatar = document.getElementById('user-avatar');
        const name = document.getElementById('user-name');
        const tag = document.getElementById('user-tag');
        const statusIndicator = document.getElementById('user-status-indicator');
        
        if (avatar) {
            avatar.src = this.currentUser.avatar ? `/uploads/${this.currentUser.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png';
        }
        if (name) name.textContent = this.currentUser.username;
        if (tag) tag.textContent = `#${this.currentUser.discriminator}`;
        if (statusIndicator) {
            statusIndicator.className = `status-indicator ${this.currentUser.status || 'online'}`;
        }
    }
    
    async loadServers() {
        try {
            const response = await fetch('/api/servers');
            if (response.ok) {
                this.servers = await response.json();
                this.renderServers();
            }
        } catch (error) {
            console.error('Error loading servers:', error);
        }
    }
    
    renderServers() {
        const serversList = document.getElementById('servers-list');
        if (!serversList) return;
        
        serversList.innerHTML = '';
        
        this.servers.forEach(server => {
            const serverIcon = document.createElement('div');
            serverIcon.className = 'server-icon';
            serverIcon.dataset.serverId = server.id;
            serverIcon.onclick = () => this.selectServer(server);
            
            if (server.icon && server.icon !== 'default_server.png') {
                const img = document.createElement('img');
                img.src = `/uploads/${server.icon}`;
                img.alt = server.name;
                serverIcon.appendChild(img);
            } else {
                serverIcon.textContent = server.name.charAt(0).toUpperCase();
            }
            
            serversList.appendChild(serverIcon);
        });
    }
    
    async selectServer(server) {
        this.currentServer = server;
        this.currentChannel = null;
        this.currentDM = null;
        
        // Скрываем список друзей при выборе сервера
        const friendsSidebar = document.getElementById('friends-sidebar');
        if (friendsSidebar) {
            friendsSidebar.style.display = 'none';
        }
        
        // Update UI
        document.querySelectorAll('.server-icon').forEach(icon => {
            icon.classList.remove('active');
        });
        document.querySelector(`[data-server-id="${server.id}"]`)?.classList.add('active');
        
        // Update header
        const serverHeader = document.getElementById('server-header');
        if (serverHeader) {
            serverHeader.querySelector('.server-name').textContent = server.name;
        }
        
        await this.loadChannels();
        this.showWelcomeMessage();
    }
    
    async loadChannels() {
        if (!this.currentServer) return;
        
        try {
            const response = await fetch(`/api/servers/${this.currentServer.id}/channels`);
            if (response.ok) {
                const data = await response.json();
                this.renderChannels(data);
            }
        } catch (error) {
            console.error('Error loading channels:', error);
        }
    }
    
    renderChannels(data) {
        const container = document.getElementById('channels-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        // Render categories
        data.categories.forEach(category => {
            const categoryDiv = document.createElement('div');
            categoryDiv.className = 'category';
            
            const categoryHeader = document.createElement('div');
            categoryHeader.className = 'category-header';
            categoryHeader.innerHTML = `
                <span>${category.name}</span>
                <i class="fas fa-chevron-down"></i>
            `;
            categoryDiv.appendChild(categoryHeader);
            
            const channelsDiv = document.createElement('div');
            channelsDiv.className = 'channels-list';
            
            category.channels.forEach(channel => {
                const channelItem = this.createChannelItem(channel);
                channelsDiv.appendChild(channelItem);
            });
            
            categoryDiv.appendChild(channelsDiv);
            container.appendChild(categoryDiv);
        });
        
        // Render uncategorized channels
        if (data.uncategorized && data.uncategorized.length > 0) {
            data.uncategorized.forEach(channel => {
                const channelItem = this.createChannelItem(channel);
                container.appendChild(channelItem);
            });
        }
        
        // Add create channel button if user is owner
        if (this.currentServer.owner_id === this.currentUser.id) {
            const addChannelBtn = document.createElement('div');
            addChannelBtn.className = 'channel-item';
            addChannelBtn.innerHTML = '<i class="fas fa-plus"></i> <span>Создать канал</span>';
            addChannelBtn.onclick = () => this.showCreateChannelModal();
            container.appendChild(addChannelBtn);
        }
    }
    
    createChannelItem(channel) {
        const item = document.createElement('div');
        item.className = 'channel-item';
        item.dataset.channelId = channel.id;
        
        const icon = channel.type === 'voice' ? 'fa-volume-up' : 'fa-hashtag';
        item.innerHTML = `
            <i class="fas ${icon}"></i>
            <span class="channel-name">${channel.name}</span>
        `;
        
        item.onclick = () => this.selectChannel(channel);
        item.oncontextmenu = (e) => {
            e.preventDefault();
            if (this.currentServer.owner_id === this.currentUser.id) {
                this.showChannelContextMenu(e, channel);
            }
        };
        
        return item;
    }
    
    async selectChannel(channel) {
        this.currentChannel = channel;
        this.currentDM = null;
        
        // Update UI
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-channel-id="${channel.id}"]`)?.classList.add('active');
        
        // Update header
        const channelName = document.getElementById('current-channel-name');
        const channelTopic = document.getElementById('current-channel-topic');
        if (channelName) {
            channelName.textContent = channel.name;
            channelName.previousElementSibling.innerHTML = 
                channel.type === 'voice' ? '<i class="fas fa-volume-up"></i>' : '<i class="fas fa-hashtag"></i>';
        }
        if (channelTopic) {
            channelTopic.textContent = channel.topic || '';
        }
        
        // Join channel room
        if (this.socket) {
            this.socket.emit('join_channel', { channel_id: channel.id });
        }
        
        // Load messages
        await this.loadMessages();
        
        // Show message form
        const messageForm = document.getElementById('message-form');
        if (messageForm) {
            messageForm.style.display = channel.type === 'text' ? 'block' : 'none';
        }
        
        // Load members
        await this.loadMembers();
    }
    
    async loadMessages() {
        if (!this.currentChannel) return;
        
        try {
            const response = await fetch(`/api/channels/${this.currentChannel.id}/messages?limit=50`);
            if (response.ok) {
                this.messages = await response.json();
                this.renderMessages();
            }
        } catch (error) {
            console.error('Error loading messages:', error);
        }
    }
    
    renderMessages() {
        const container = document.getElementById('messages-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        if (this.messages.length === 0) {
            container.innerHTML = '<div class="welcome-message"><h2>Начните общение!</h2><p>Это начало канала #' + this.currentChannel.name + '</p></div>';
            return;
        }
        
        let lastAuthorId = null;
        
        this.messages.forEach(message => {
            const messageDiv = this.createMessageElement(message, lastAuthorId === message.author.id);
            container.appendChild(messageDiv);
            lastAuthorId = message.author.id;
        });
        
        this.scrollToBottom();
    }
    
    createMessageElement(message, isGrouped) {
        const wrapper = document.createElement('div');
        wrapper.className = 'message-wrapper';
        wrapper.dataset.messageId = message.id;
        
        if (isGrouped) {
            wrapper.style.paddingTop = '2px';
        }
        
        const avatar = isGrouped ? '<div style="width: 40px;"></div>' : `
            <div class="message-avatar">
                <img src="${message.author.avatar ? `/uploads/${message.author.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${message.author.username}">
            </div>
        `;
        
        const replyPreview = message.reply_to ? `
            <div class="message-reply">
                <span class="message-reply-author">${message.reply_to.author.username}</span>
                ${message.reply_to.content.substring(0, 50)}${message.reply_to.content.length > 50 ? '...' : ''}
            </div>
        ` : '';
        
        const attachments = message.attachments && message.attachments.length > 0 ? `
            <div class="message-attachments">
                ${message.attachments.map(att => {
                    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(att.file_type)) {
                        return `<div class="attachment"><img src="${att.url}" alt="${att.original_filename}"></div>`;
                    } else if (['mp4', 'webm'].includes(att.file_type)) {
                        return `<div class="attachment"><video controls src="${att.url}"></video></div>`;
                    } else {
                        return `
                            <a href="${att.url}" class="attachment-file" download>
                                <i class="fas fa-file"></i>
                                <div class="attachment-file-info">
                                    <div class="attachment-file-name">${att.original_filename}</div>
                                    <div class="attachment-file-size">${this.formatFileSize(att.file_size)}</div>
                                </div>
                            </a>
                        `;
                    }
                }).join('')}
            </div>
        ` : '';
        
        const reactions = message.reactions && message.reactions.length > 0 ? `
            <div class="message-reactions">
                ${message.reactions.map(reaction => `
                    <div class="reaction ${reaction.users.includes(this.currentUser.id) ? 'active' : ''}" 
                         onclick="app.toggleReaction(${message.id}, '${reaction.emoji}')">
                        <span class="reaction-emoji">${reaction.emoji}</span>
                        <span class="reaction-count">${reaction.count}</span>
                    </div>
                `).join('')}
            </div>
        ` : '';
        
        const editedBadge = message.edited_at ? '<span style="color: var(--text-muted); font-size: 12px;"> (изменено)</span>' : '';
        
        const actions = `
            <div class="message-actions">
                <button class="message-action-btn" onclick="app.reactToMessage(${message.id})" title="Добавить реакцию">
                    <i class="far fa-smile"></i>
                </button>
                ${message.author.id === this.currentUser.id ? `
                    <button class="message-action-btn" onclick="app.editMessage(${message.id})" title="Редактировать">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="message-action-btn danger" onclick="app.deleteMessage(${message.id})" title="Удалить">
                        <i class="fas fa-trash"></i>
                    </button>
                ` : `
                    <button class="message-action-btn" onclick="app.replyToMessage(${message.id})" title="Ответить">
                        <i class="fas fa-reply"></i>
                    </button>
                `}
            </div>
        `;
        
        wrapper.innerHTML = `
            ${avatar}
            <div class="message-content">
                ${!isGrouped ? `
                    <div class="message-header">
                        <span class="message-author">${message.author.username}</span>
                        <span class="message-timestamp">${this.formatTimestamp(message.created_at)}</span>
                    </div>
                ` : ''}
                ${replyPreview}
                <div class="message-bubble">${this.formatMessage(message.content)}${editedBadge}</div>
                ${attachments}
                ${reactions}
            </div>
            ${actions}
        `;
        
        // Добавляем класс own-message для своих сообщений
        if (message.author.id === this.currentUser.id) {
            wrapper.classList.add('own-message');
        }
        
        return wrapper;
    }
    
    formatMessage(content) {
        // Simple markdown-like formatting
        return content
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>')
            .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
    }
    
    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'только что';
        if (diff < 3600000) return `${Math.floor(diff / 60000)} мин. назад`;
        if (diff < 86400000 && date.getDate() === now.getDate()) {
            return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' Б';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
        return (bytes / 1048576).toFixed(1) + ' МБ';
    }
    
    addMessage(message) {
        const container = document.getElementById('messages-container');
        if (!container) return;
        
        const welcomeMsg = container.querySelector('.welcome-message');
        if (welcomeMsg) welcomeMsg.remove();
        
        // For DM messages, use different element creation
        if (this.currentDM && !this.currentChannel) {
            const messageDiv = this.createDMMessageElement(message);
            container.appendChild(messageDiv);
            this.scrollToBottom();
            return;
        }
        
        const lastMessage = container.lastElementChild;
        const isGrouped = lastMessage && 
            lastMessage.querySelector('.message-author')?.textContent === message.author.username &&
            (new Date(message.created_at) - new Date(this.messages[this.messages.length - 1]?.created_at)) < 420000;
        
        const messageDiv = this.createMessageElement(message, isGrouped);
        container.appendChild(messageDiv);
        this.scrollToBottom();
    }
    
    updateMessage(message) {
        const messageDiv = document.querySelector(`[data-message-id="${message.id}"]`);
        if (messageDiv) {
            const newDiv = this.createMessageElement(message, false);
            messageDiv.replaceWith(newDiv);
            
            const index = this.messages.findIndex(m => m.id === message.id);
            if (index !== -1) {
                this.messages[index] = message;
            }
        }
    }
    
    removeMessage(messageId) {
        const messageDiv = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageDiv) {
            messageDiv.remove();
        }
        
        this.messages = this.messages.filter(m => m.id !== messageId);
    }
    
    scrollToBottom() {
        const container = document.getElementById('messages-container');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }
    
    async sendMessage() {
        const input = document.getElementById('message-input');
        const content = input?.value.trim();
        
        if (!content && this.attachments.length === 0) return;
        
        // Handle DM messages
        if (this.currentDM && !this.currentChannel) {
            if (this.socket) {
                this.socket.emit('send_dm', {
                    receiver_id: this.currentDM.id,
                    content: content
                });
            }
            
            if (input) input.value = '';
            this.attachments = [];
            this.replyToMessage = null;
            this.updateAttachmentsPreview();
            this.updateReplyPreview();
            return;
        }
        
        // Handle channel messages
        if (!this.currentChannel) return;
        
        const messageData = {
            channel_id: this.currentChannel.id,
            content: content || '',
            reply_to_id: this.replyToMessage?.id || null,
            attachments: this.attachments
        };
        
        if (this.socket) {
            this.socket.emit('send_message', messageData);
        }
        
        if (input) input.value = '';
        this.attachments = [];
        this.replyToMessage = null;
        this.updateAttachmentsPreview();
        this.updateReplyPreview();
        this.hideTyping();
    }
    
    handleTyping() {
        if (!this.currentChannel && !this.currentDM) return;
        
        if (this.currentChannel && this.socket) {
            this.socket.emit('typing', { channel_id: this.currentChannel.id });
        }
        
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            if (this.currentChannel && this.socket) {
                this.socket.emit('stop_typing', { channel_id: this.currentChannel.id });
            }
        }, 3000);
    }
    
    showTyping(user) {
        if (!this.currentChannel || user.id === this.currentUser.id) return;
        
        this.typingUsers.add(user.id);
        this.updateTypingIndicator();
    }
    
    hideTyping(userId) {
        this.typingUsers.delete(userId);
        this.updateTypingIndicator();
    }
    
    updateTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        const text = document.getElementById('typing-text');
        
        if (this.typingUsers.size === 0) {
            if (indicator) indicator.style.display = 'none';
            return;
        }
        
        if (indicator) indicator.style.display = 'flex';
        // In a real app, you'd fetch user names
        if (text) text.textContent = 'Печатает...';
    }
    
    async loadMembers() {
        if (!this.currentServer) return;
        
        try {
            const response = await fetch(`/api/servers/${this.currentServer.id}/members`);
            if (response.ok) {
                const members = await response.json();
                this.renderMembers(members);
            }
        } catch (error) {
            console.error('Error loading members:', error);
        }
    }
    
    renderMembers(members) {
        const container = document.getElementById('members-list');
        if (!container) return;
        
        container.innerHTML = '';
        
        const onlineMembers = members.filter(m => m.is_online);
        const offlineMembers = members.filter(m => !m.is_online);
        
        if (onlineMembers.length > 0) {
            const section = document.createElement('div');
            section.className = 'members-section';
            section.innerHTML = '<div class="members-section-title">Онлайн — ' + onlineMembers.length + '</div>';
            
            onlineMembers.forEach(member => {
                section.appendChild(this.createMemberItem(member));
            });
            
            container.appendChild(section);
        }
        
        if (offlineMembers.length > 0) {
            const section = document.createElement('div');
            section.className = 'members-section';
            section.innerHTML = '<div class="members-section-title">Не в сети — ' + offlineMembers.length + '</div>';
            
            offlineMembers.forEach(member => {
                section.appendChild(this.createMemberItem(member));
            });
            
            container.appendChild(section);
        }
    }
    
    createMemberItem(member) {
        const item = document.createElement('div');
        item.className = 'member-item';
        
        const statusClass = member.is_online ? 'online' : 'offline';
        
        item.innerHTML = `
            <div class="member-avatar">
                <img src="${member.avatar ? `/uploads/${member.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${member.username}">
                <span class="status-indicator ${statusClass}"></span>
            </div>
            <div class="member-name">${member.username}</div>
        `;
        
        return item;
    }
    
    updateUserStatus(userId, status) {
        // Update in members list
        document.querySelectorAll('.member-item').forEach(item => {
            const avatar = item.querySelector('.member-avatar');
            if (avatar && avatar.dataset.userId === userId.toString()) {
                const indicator = avatar.querySelector('.status-indicator');
                if (indicator) {
                    indicator.className = `status-indicator ${status}`;
                }
            }
        });
    }
    
    // DM Functions
    async showDMs() {
        this.currentServer = null;
        this.currentChannel = null;
        
        // Показываем список друзей
        const friendsSidebar = document.getElementById('friends-sidebar');
        if (friendsSidebar) {
            friendsSidebar.style.display = 'block';
        }
        
        // Загружаем и отображаем друзей
        await this.loadFriends();
        this.renderFriendsSidebar();
        
        try {
            const response = await fetch('/api/dm/conversations');
            if (response.ok) {
                const conversations = await response.json();
                this.renderDMList(conversations);
            }
        } catch (error) {
            console.error('Error loading DMs:', error);
        }
        
        const serverHeader = document.getElementById('server-header');
        if (serverHeader) {
            serverHeader.querySelector('.server-name').textContent = 'Личные сообщения';
        }
        
        this.showWelcomeMessage();
    }
    
    renderFriendsSidebar() {
        const container = document.getElementById('friends-list-sidebar');
        if (!container) return;
        
        if (this.friends.length === 0) {
            container.innerHTML = `
                <div class="friends-empty">
                    <p>У вас пока нет друзей</p>
                    <button class="btn btn-primary" onclick="app.showAddFriendModal()">Добавить друга</button>
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.friends.map(friend => `
            <div class="friend-item-sidebar" data-friend-id="${friend.id}" onclick="app.selectFriend(${friend.id})">
                <div class="friend-avatar">
                    <img src="${friend.avatar ? `/uploads/${friend.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${friend.username}">
                    <span class="status-indicator ${friend.status || 'offline'}"></span>
                </div>
                <div class="friend-info">
                    <div class="friend-name">${friend.username}</div>
                    <div class="friend-status">${friend.custom_status || friend.status || 'Офлайн'}</div>
                </div>
                <div class="friend-actions-sidebar">
                    <button class="friend-action-btn" onclick="event.stopPropagation(); app.startCall(${friend.id}, 'video')" title="Видеозвонок">
                        <i class="fas fa-video"></i>
                    </button>
                    <button class="friend-action-btn" onclick="event.stopPropagation(); app.startCall(${friend.id}, 'audio')" title="Звонок">
                        <i class="fas fa-phone"></i>
                    </button>
                    <button class="friend-action-btn" onclick="event.stopPropagation(); app.startCall(${friend.id}, 'screen')" title="Демонстрация экрана">
                        <i class="fas fa-desktop"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    selectFriend(friendId) {
        const friend = this.friends.find(f => f.id === friendId);
        if (!friend) return;
        
        // Открываем DM с другом
        this.openDM(friendId);
    }
    
    showAddFriendModal() {
        // Проверяем, не открыто ли уже модальное окно
        const existingModal = document.getElementById('add-friend-modal');
        if (existingModal) {
            existingModal.remove();
            const overlay = document.getElementById('modal-overlay');
            if (overlay) {
                overlay.classList.remove('active');
                overlay.style.display = 'none';
            }
            return;
        }
        
        // Создаем модальное окно по центру (как настройки)
        const overlay = document.getElementById('modal-overlay');
        const modal = document.createElement('div');
        modal.id = 'add-friend-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-header">
                <h2>Добавить друга</h2>
                <button class="modal-close" onclick="app.closeAddFriendModal()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label>Имя пользователя</label>
                    <input type="text" id="add-friend-username-menu" placeholder="username" style="width: 100%; margin-bottom: 8px;">
                </div>
                <div class="form-group">
                    <label>Discriminator</label>
                    <input type="text" id="add-friend-discriminator-menu" placeholder="0000" maxlength="4" style="width: 100%;">
                </div>
                <p style="color: var(--text-muted); font-size: 12px; margin-top: 8px; margin-bottom: 12px;">
                    Введите имя пользователя и discriminator друга (например: username#1234)
                </p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.closeAddFriendModal()">Отмена</button>
                <button class="btn btn-primary" onclick="app.addFriendFromMenu()">Отправить запрос</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Показываем overlay и модальное окно
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.zIndex = '1001';
            overlay.style.pointerEvents = 'auto';
            overlay.classList.add('active');
        }
        modal.style.display = 'flex';
        modal.style.zIndex = '1002';
        modal.style.pointerEvents = 'auto';
        modal.classList.add('active');
    }
    
    closeAddFriendModal() {
        const modal = document.getElementById('add-friend-modal');
        const overlay = document.getElementById('modal-overlay');
        if (modal) modal.remove();
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        }
    }
    
    async addFriendFromMenu() {
        // Проверка подтверждения email
        if (!this.currentUser || !this.currentUser.email_verified) {
            this.showNotification('Для добавления друзей необходимо подтвердить email', 'error');
            return;
        }
        
        const usernameInput = document.getElementById('add-friend-username-menu');
        const discriminatorInput = document.getElementById('add-friend-discriminator-menu');
        
        if (!usernameInput || !discriminatorInput) {
            this.showNotification('Поля не найдены', 'error');
            return;
        }
        
        const username = usernameInput.value.trim();
        const discriminator = discriminatorInput.value.trim();
        
        if (!username || !discriminator) {
            this.showNotification('Заполните все поля', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/friends/add', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, discriminator})
            });
            
            const data = await response.json();
            if (response.ok) {
                this.showNotification('Запрос отправлен', 'success');
                // Закрываем модальное окно
                this.closeAddFriendModal();
                // Очищаем поля
                usernameInput.value = '';
                discriminatorInput.value = '';
                // Обновляем списки
                await this.loadFriends();
                await this.loadFriendRequests();
                this.renderFriendsSidebar();
            } else {
                this.showNotification(data.error || 'Ошибка', 'error');
            }
        } catch (error) {
            console.error('Error adding friend:', error);
            this.showNotification('Ошибка при отправке запроса', 'error');
        }
    }
    
    async addFriendFromModal() {
        const username = document.getElementById('add-friend-username').value.trim();
        const discriminator = document.getElementById('add-friend-discriminator').value.trim();
        
        if (!username || !discriminator) {
            this.showNotification('Заполните все поля', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/friends/add', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, discriminator})
            });
            
            const data = await response.json();
            if (response.ok) {
                this.showNotification('Запрос отправлен', 'success');
                document.getElementById('add-friend-modal').remove();
                document.getElementById('modal-overlay').classList.remove('active');
                await this.loadFriends();
                await this.loadFriendRequests();
                this.renderFriendsSidebar();
            } else {
                this.showNotification(data.error || 'Ошибка', 'error');
            }
        } catch (error) {
            console.error('Error adding friend:', error);
            this.showNotification('Ошибка при отправке запроса', 'error');
        }
    }
    
    renderDMList(conversations) {
        const container = document.getElementById('channels-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        conversations.forEach(user => {
            const dmItem = document.createElement('div');
            dmItem.className = `dm-item ${this.currentDM?.id === user.id ? 'active' : ''}`;
            dmItem.dataset.userId = user.id;
            dmItem.onclick = () => this.selectDM(user);
            
            const unreadBadge = user.unread > 0 ? `<span class="dm-unread">${user.unread}</span>` : '';
            
            dmItem.innerHTML = `
                <div class="dm-avatar">
                    <img src="${user.avatar ? `/uploads/${user.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${user.username}">
                    <span class="status-indicator ${user.is_online ? 'online' : 'offline'}"></span>
                </div>
                <div class="dm-info">
                    <div class="dm-name">${user.username}</div>
                </div>
                ${unreadBadge}
            `;
            
            container.appendChild(dmItem);
        });
    }
    
    async selectDM(user) {
        this.currentDM = user;
        this.currentChannel = null;
        this.currentServer = null;
        
        document.querySelectorAll('.dm-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-user-id="${user.id}"]`)?.classList.add('active');
        
        const channelName = document.getElementById('current-channel-name');
        if (channelName) {
            channelName.textContent = user.username;
            channelName.previousElementSibling.innerHTML = '<i class="fas fa-user"></i>';
        }
        
        try {
            const response = await fetch(`/api/dm/${user.id}/messages`);
            if (response.ok) {
                const messages = await response.json();
                this.messages = messages;
                this.renderDMMessages();
            }
        } catch (error) {
            console.error('Error loading DM messages:', error);
        }
        
        const messageForm = document.getElementById('message-form');
        if (messageForm) messageForm.style.display = 'block';
    }
    
    renderDMMessages() {
        const container = document.getElementById('messages-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        if (this.messages.length === 0) {
            container.innerHTML = '<div class="welcome-message"><h2>Начните общение!</h2><p>Это начало личных сообщений с ' + this.currentDM.username + '</p></div>';
            return;
        }
        
        this.messages.forEach(message => {
            const messageDiv = this.createDMMessageElement(message);
            container.appendChild(messageDiv);
        });
        
        this.scrollToBottom();
    }
    
    createDMMessageElement(message) {
        const wrapper = document.createElement('div');
        wrapper.className = 'message-wrapper';
        
        // Determine if message is from current user or other user
        const isFromCurrentUser = message.author && message.author.id === this.currentUser.id;
        const author = message.author || message.sender;
        
        if (isFromCurrentUser) {
            wrapper.classList.add('own-message');
        }
        
        wrapper.innerHTML = `
            <div class="message-avatar">
                <img src="${author.avatar ? `/uploads/${author.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${author.username}">
            </div>
            <div class="message-content">
                <div class="message-bubble">${this.formatMessage(message.content)}</div>
                <div class="message-timestamp" style="font-size: 11px; color: var(--text-muted); margin-top: 4px; ${isFromCurrentUser ? 'text-align: right;' : ''}">${this.formatTimestamp(message.created_at)}</div>
            </div>
        `;
        
        return wrapper;
    }
    
    
    // Server Management
    showCreateServerModal() {
        document.getElementById('create-server-modal').classList.add('active');
        document.getElementById('modal-overlay').classList.add('active');
    }
    
    async createServer() {
        // Проверка подтверждения email
        if (!this.currentUser || !this.currentUser.email_verified) {
            this.showNotification('Для создания серверов необходимо подтвердить email', 'error');
            return;
        }
        
        const nameInput = document.getElementById('new-server-name');
        const name = nameInput?.value.trim();
        
        if (!name) {
            this.showNotification('Введите название сервера', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/servers/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            
            if (response.ok) {
                const server = await response.json();
                this.servers.push(server);
                this.renderServers();
                this.selectServer(server);
                this.closeModal();
            }
        } catch (error) {
            console.error('Error creating server:', error);
            this.showNotification('Ошибка при создании сервера', 'error');
        }
    }
    
    showJoinServerModal() {
        document.getElementById('join-server-modal').classList.add('active');
        document.getElementById('modal-overlay').classList.add('active');
    }
    
    async joinServer() {
        const codeInput = document.getElementById('invite-code');
        let code = codeInput?.value.trim();
        
        // Extract code from URL if provided
        if (code.includes('discord.gg/') || code.includes('/')) {
            code = code.split('/').pop();
        }
        
        if (!code) {
            this.showNotification('Введите код приглашения', 'error');
            return;
        }
        
        try {
            const response = await fetch(`/api/invite/${code}`);
            if (response.ok) {
                const server = await response.json();
                await this.loadServers();
                this.selectServer(server);
                this.closeModal();
                this.showNotification('Вы присоединились к серверу!', 'success');
            } else {
                this.showNotification('Неверный код приглашения', 'error');
            }
        } catch (error) {
            console.error('Error joining server:', error);
            this.showNotification('Ошибка при присоединении', 'error');
        }
    }
    
    // Channel Management
    showCreateChannelModal() {
        this.selectedChannelType = 'text';
        document.querySelectorAll('.channel-type').forEach(type => {
            type.classList.remove('active');
        });
        document.querySelector('[data-type="text"]')?.classList.add('active');
        document.getElementById('create-channel-modal').classList.add('active');
        document.getElementById('modal-overlay').classList.add('active');
    }
    
    selectChannelType(type) {
        this.selectedChannelType = type;
        document.querySelectorAll('.channel-type').forEach(t => t.classList.remove('active'));
        document.querySelector(`[data-type="${type}"]`)?.classList.add('active');
    }
    
    async createChannel() {
        if (!this.currentServer) return;
        
        const nameInput = document.getElementById('new-channel-name');
        const name = nameInput?.value.trim();
        
        if (!name) {
            this.showNotification('Введите название канала', 'error');
            return;
        }
        
        try {
            const response = await fetch(`/api/servers/${this.currentServer.id}/channels/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name,
                    type: this.selectedChannelType
                })
            });
            
            if (response.ok) {
                const channel = await response.json();
                await this.loadChannels();
                this.selectChannel(channel);
                this.closeModal();
            }
        } catch (error) {
            console.error('Error creating channel:', error);
            this.showNotification('Ошибка при создании канала', 'error');
        }
    }
    
    showChannelContextMenu(e, channel) {
        const menu = document.getElementById('context-menu');
        if (!menu) return;
        
        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        
        menu.innerHTML = `
            <div class="context-menu-item" onclick="app.deleteChannel(${channel.id})">
                <i class="fas fa-trash"></i>
                <span>Удалить канал</span>
            </div>
        `;
        
        e.stopPropagation();
    }
    
    async deleteChannel(channelId) {
        if (!confirm('Вы уверены, что хотите удалить этот канал?')) return;
        
        try {
            const response = await fetch(`/api/channels/${channelId}/delete`, {
                method: 'POST'
            });
            
            if (response.ok) {
                this.hideContextMenu();
                await this.loadChannels();
            }
        } catch (error) {
            console.error('Error deleting channel:', error);
        }
    }
    
    // Message Actions
    replyToMessage(messageId) {
        const message = this.messages.find(m => m.id === messageId);
        if (message) {
            this.replyToMessage = message;
            this.updateReplyPreview();
        }
    }
    
    cancelReply() {
        this.replyToMessage = null;
        this.updateReplyPreview();
    }
    
    updateReplyPreview() {
        const preview = document.getElementById('reply-preview');
        const name = document.getElementById('reply-to-name');
        
        if (this.replyToMessage && preview && name) {
            preview.style.display = 'flex';
            name.textContent = this.replyToMessage.author.username;
        } else if (preview) {
            preview.style.display = 'none';
        }
    }
    
    async reactToMessage(messageId) {
        const emoji = prompt('Введите эмодзи:');
        if (emoji) {
            await this.toggleReaction(messageId, emoji);
        }
    }
    
    reactToMessage(messageId) {
        // Показать эмодзи пикер для добавления реакции
        this.toggleEmojiPicker();
        // Сохранить messageId для добавления реакции после выбора эмодзи
        this.reactingToMessage = messageId;
    }
    
    async toggleReaction(messageId, emoji) {
        try {
            const response = await fetch(`/api/messages/${messageId}/reactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emoji })
            });
            
            if (response.ok) {
                const message = await response.json();
                this.updateMessage(message);
            }
        } catch (error) {
            console.error('Error toggling reaction:', error);
        }
    }
    
    async editMessage(messageId) {
        const message = this.messages.find(m => m.id === messageId);
        if (!message) return;
        
        const newContent = prompt('Редактировать сообщение:', message.content);
        if (newContent === null) return;
        
        try {
            const response = await fetch(`/api/messages/${messageId}/edit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: newContent })
            });
            
            if (response.ok) {
                const updated = await response.json();
                this.updateMessage(updated);
            }
        } catch (error) {
            console.error('Error editing message:', error);
        }
    }
    
    async deleteMessage(messageId) {
        if (!confirm('Вы уверены, что хотите удалить это сообщение?')) return;
        
        try {
            const response = await fetch(`/api/messages/${messageId}/delete`, {
                method: 'POST'
            });
            
            if (response.ok) {
                this.removeMessage(messageId);
            }
        } catch (error) {
            console.error('Error deleting message:', error);
        }
    }
    
    // File Handling
    handleFileSelect(event) {
        const files = Array.from(event.target.files);
        
        files.forEach(file => {
            if (file.size > 50 * 1024 * 1024) {
                this.showNotification('Файл слишком большой (макс. 50 МБ)', 'error');
                return;
            }
            
            const reader = new FileReader();
            reader.onload = (e) => {
                this.uploadFile(file, e.target.result);
            };
            reader.readAsDataURL(file);
        });
        
        event.target.value = '';
    }
    
    async uploadFile(file, preview) {
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            
            if (response.ok) {
                const attachment = await response.json();
                this.attachments.push(attachment);
                this.updateAttachmentsPreview();
            } else {
                this.showNotification('Ошибка при загрузке файла', 'error');
            }
        } catch (error) {
            console.error('Error uploading file:', error);
            this.showNotification('Ошибка при загрузке файла', 'error');
        }
    }
    
    updateAttachmentsPreview() {
        const preview = document.getElementById('attachments-preview');
        if (!preview) return;
        
        preview.innerHTML = '';
        
        this.attachments.forEach((att, index) => {
            const div = document.createElement('div');
            div.className = 'attachment-preview';
            
            if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(att.file_type)) {
                div.innerHTML = `
                    <img src="${att.url}" alt="${att.original_filename}">
                    <button class="attachment-preview-remove" onclick="app.removeAttachment(${index})">
                        <i class="fas fa-times"></i>
                    </button>
                `;
            } else {
                div.innerHTML = `
                    <div style="padding: 8px; background: var(--bg-secondary); border-radius: 4px;">
                        ${att.original_filename}
                        <button onclick="app.removeAttachment(${index})" style="margin-left: 8px;">×</button>
                    </div>
                `;
            }
            
            preview.appendChild(div);
        });
    }
    
    removeAttachment(index) {
        this.attachments.splice(index, 1);
        this.updateAttachmentsPreview();
    }
    
    // Emoji Picker
    toggleEmojiPicker() {
        this.emojiPickerVisible = !this.emojiPickerVisible;
        const picker = document.getElementById('emoji-picker');
        if (picker) {
            picker.style.display = this.emojiPickerVisible ? 'block' : 'none';
            if (this.emojiPickerVisible) {
                this.loadEmojis();
            }
        }
    }
    
    hideEmojiPicker() {
        this.emojiPickerVisible = false;
        const picker = document.getElementById('emoji-picker');
        if (picker) picker.style.display = 'none';
    }
    
    loadEmojis() {
        const container = document.getElementById('emoji-list');
        if (!container) return;
        
        // Simple emoji list (in production, use a proper emoji library)
        const emojis = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾'];
        
        container.innerHTML = '';
        emojis.forEach(emoji => {
            const div = document.createElement('div');
            div.className = 'emoji-item';
            div.textContent = emoji;
            div.onclick = () => this.insertEmoji(emoji);
            container.appendChild(div);
        });
    }
    
    insertEmoji(emoji) {
        // Если добавляем реакцию к сообщению
        if (this.reactingToMessage) {
            this.toggleReaction(this.reactingToMessage, emoji);
            this.reactingToMessage = null;
            this.hideEmojiPicker();
            return;
        }
        
        // Иначе вставляем в поле ввода
        const input = document.getElementById('message-input');
        if (input) {
            input.value += emoji;
            input.focus();
        }
        this.hideEmojiPicker();
    }
    
    // Settings
    showSettings() {
        const modal = document.getElementById('user-settings-modal');
        const overlay = document.getElementById('modal-overlay');
        if (modal && overlay) {
            // Убеждаемся, что overlay не блокирует модальное окно
            overlay.style.pointerEvents = 'auto';
            overlay.style.zIndex = '1001';
            
            // Показываем overlay
            overlay.style.display = 'flex';
            overlay.classList.add('active');
            
            // Показываем модальное окно поверх overlay
            modal.style.display = 'flex';
            modal.style.zIndex = '1002';
            modal.style.pointerEvents = 'auto';
            modal.classList.add('active');
            
            // Загружаем контент
            this.showSettingsSection('account');
        }
    }
    
    showUserSettings(e) {
        // Предотвращаем случайное открытие при загрузке
        if (e && e.type === 'click') {
            this.showSettings();
        }
    }
    
    showSettingsSection(section) {
        // Предотвращаем двойные вызовы
        if (this._settingsSectionLoading === section) {
            return;
        }
        this._settingsSectionLoading = section;
        
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.classList.remove('active');
        });
        const navItem = document.querySelector(`[data-section="${section}"]`);
        if (navItem) {
            navItem.classList.add('active');
        }
        
        const content = document.getElementById('user-settings-content');
        if (!content) {
            console.error('Settings content container not found');
            this._settingsSectionLoading = null;
            return;
        }
        
        // Очищаем контент и показываем загрузку
        content.innerHTML = '<div class="settings-section"><p style="padding: 20px; text-align: center;">Загрузка...</p></div>';
        content.style.display = 'block';
        content.style.visibility = 'visible';
        content.style.opacity = '1';
        
        // Загружаем контент синхронно (без setTimeout)
        try {
                switch(section) {
                    case 'account':
                        this.showAccountSettings(content);
                        break;
                    case 'friends':
                        this.showFriendsSettings(content);
                        break;
                    case 'audio':
                        this.showAudioSettings(content);
                        break;
                    case 'security':
                        this.showSecuritySettings(content);
                        break;
                    case 'devices':
                        this.showDevicesSettings(content);
                        break;
                    default:
                        content.innerHTML = '<div class="settings-section"><p style="padding: 20px;">Раздел не найден</p></div>';
                }
        } catch (error) {
            console.error('Error in showSettingsSection:', error);
            content.innerHTML = `<div class="settings-section"><p style="padding: 20px; color: var(--text-danger);">Ошибка загрузки: ${error.message}</p></div>`;
        } finally {
            this._settingsSectionLoading = null;
        }
    }
    
    showAccountSettings(container) {
        if (!this.currentUser) {
            container.innerHTML = '<div class="settings-section"><p style="padding: 20px; text-align: center;">Загрузка данных пользователя...</p></div>';
            // Попробуем загрузить пользователя
            this.loadUser().then(() => {
                if (this.currentUser) {
                    this.showAccountSettings(container);
                }
            });
            return;
        }
        
        const safeUsername = (this.currentUser.username || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const safeAboutMe = (this.currentUser.about_me || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const safeCustomStatus = (this.currentUser.custom_status || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const avatarUrl = this.currentUser.avatar ? `/uploads/${this.currentUser.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png';
        
        container.innerHTML = `
            <div class="settings-section">
                <h3>Мой аккаунт</h3>
                <div class="form-group">
                    <label>Имя пользователя</label>
                    <input type="text" id="settings-username" value="${safeUsername}" placeholder="Имя пользователя">
                </div>
                <div class="form-group">
                    <label>О себе</label>
                    <textarea id="settings-about" rows="3" placeholder="Расскажите о себе">${safeAboutMe}</textarea>
                </div>
                <div class="form-group">
                    <label>Аватар</label>
                    <div class="avatar-upload">
                        <img id="settings-avatar-preview" src="${avatarUrl}" alt="Avatar" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover;">
                        <div style="margin-top: 10px;">
                            <input type="file" id="settings-avatar-input" accept="image/*" style="display: none;" onchange="app.handleAvatarUpload(event)">
                            <button class="btn btn-secondary" onclick="document.getElementById('settings-avatar-input').click()">Изменить аватар</button>
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Статус</label>
                    <select id="settings-status">
                        <option value="online" ${this.currentUser.status === 'online' ? 'selected' : ''}>Онлайн</option>
                        <option value="idle" ${this.currentUser.status === 'idle' ? 'selected' : ''}>Не активен</option>
                        <option value="dnd" ${this.currentUser.status === 'dnd' ? 'selected' : ''}>Не беспокоить</option>
                        <option value="invisible" ${this.currentUser.status === 'invisible' ? 'selected' : ''}>Невидимый</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Пользовательский статус</label>
                    <input type="text" id="settings-custom-status" value="${safeCustomStatus}" placeholder="Например: Играю в игру" maxlength="128">
                </div>
                <button class="btn btn-primary" onclick="app.saveAccountSettings()">Сохранить изменения</button>
            </div>
        `;
    }
    
    showFriendsSettings(container) {
        if (!this.friends) this.friends = [];
        if (!this.friendRequests) this.friendRequests = [];
        
        container.innerHTML = `
            <div class="settings-section">
                <h3>Друзья</h3>
                <div class="add-friend-section">
                    <h4>Добавить друга</h4>
                    <div class="form-group">
                        <input type="text" id="friend-username" placeholder="Имя пользователя" style="width: 200px; display: inline-block;">
                        <span style="margin: 0 8px;">#</span>
                        <input type="text" id="friend-discriminator" placeholder="0000" maxlength="4" style="width: 80px; display: inline-block;">
                        <button class="btn btn-primary" onclick="app.addFriendFromSettings()" style="margin-left: 8px;">Отправить запрос</button>
                    </div>
                </div>
                <div class="friend-requests-section">
                    <h4>Запросы в друзья (${this.friendRequests.length})</h4>
                    <div id="friend-requests-list" class="friends-list">
                        ${this.friendRequests.length === 0 ? '<p style="color: var(--text-muted);">Нет входящих запросов</p>' : ''}
                    </div>
                </div>
                <div class="friends-list-section">
                    <h4>Друзья (${this.friends.length})</h4>
                    <div id="friends-list" class="friends-list">
                        ${this.friends.length === 0 ? '<p style="color: var(--text-muted);">У вас пока нет друзей</p>' : ''}
                    </div>
                </div>
            </div>
        `;
        this.renderFriendsList();
        this.renderFriendRequests();
    }
    
    showAudioSettings(container) {
        container.innerHTML = '<div class="settings-section"><p style="padding: 20px; text-align: center;">Загрузка настроек...</p></div>';
        fetch('/api/user/audio-settings')
            .then(r => r.json())
            .catch(() => ({}))
            .then(settings => {
                if (!settings) settings = {};
                const volume = settings.audio_volume || 100;
                const videoEnabled = settings.video_enabled || false;
                container.innerHTML = `
                    <div class="settings-section">
                        <h3>Настройки аудио и видео</h3>
                        <div class="form-group">
                            <label>Устройство ввода (микрофон)</label>
                            <select id="audio-input-device" class="device-select"></select>
                        </div>
                        <div class="form-group">
                            <label>Устройство вывода (динамики/наушники)</label>
                            <select id="audio-output-device" class="device-select"></select>
                        </div>
                        <div class="form-group">
                            <label>Видео устройство (камера)</label>
                            <select id="video-device" class="device-select"></select>
                        </div>
                        <div class="form-group">
                            <label>Громкость: <span id="volume-value">${volume}</span>%</label>
                            <input type="range" id="audio-volume" min="0" max="100" value="${volume}" 
                                   oninput="document.getElementById('volume-value').textContent = this.value">
                        </div>
                        <div class="form-group">
                            <label>
                                <input type="checkbox" id="video-enabled" ${videoEnabled ? 'checked' : ''}>
                                Включить видео по умолчанию
                            </label>
                        </div>
                        <div class="form-group">
                            <label>Тест микрофона</label>
                            <button class="btn btn-secondary" id="test-mic-btn" onclick="app.testMicrophone()">Тест микрофона</button>
                            <div id="mic-test-result" style="margin-top: 8px;"></div>
                        </div>
                        <button class="btn btn-primary" onclick="app.saveAudioSettings()">Сохранить</button>
                    </div>
                `;
                this.loadAudioDevices();
            });
    }
    
    showSecuritySettings(container) {
        if (!this.currentUser) {
            container.innerHTML = '<div class="settings-section"><p style="padding: 20px; text-align: center;">Загрузка данных пользователя...</p></div>';
            this.loadUser().then(() => {
                if (this.currentUser) {
                    this.showSecuritySettings(container);
                }
            });
            return;
        }
        
        const twoFactorEnabled = this.currentUser.two_factor_enabled || false;
        const emailVerified = this.currentUser.email_verified || false;
        
        container.innerHTML = `
            <div class="settings-section">
                <h3>Безопасность</h3>
                <div class="security-section">
                    <h4>Двухфакторная аутентификация (2FA)</h4>
                    <p style="color: var(--text-muted); margin-bottom: 16px;">
                        ${twoFactorEnabled ? '<span style="color: var(--success);">✓ 2FA включена</span>' : '<span style="color: var(--text-muted);">✗ 2FA отключена</span>'}
                    </p>
                    <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px;">
                        Двухфакторная аутентификация добавляет дополнительный уровень безопасности к вашему аккаунту.
                    </p>
                    ${!twoFactorEnabled ? `
                        <button class="btn btn-primary" onclick="app.enable2FA()">Включить 2FA</button>
                    ` : `
                        <button class="btn btn-danger" onclick="app.disable2FA()">Отключить 2FA</button>
                    `}
                </div>
                <div class="security-section" style="margin-top: 32px;">
                    <h4>Подтверждение Email</h4>
                    <p style="color: var(--text-muted); margin-bottom: 16px;">
                        ${emailVerified ? '<span style="color: var(--success);">✓ Email подтверждён</span>' : '<span style="color: var(--text-danger);">✗ Email не подтверждён</span>'}
                    </p>
                    <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px;">
                        ${emailVerified ? 'Ваш email подтверждён и используется для восстановления аккаунта.' : 'Подтвердите ваш email для безопасности аккаунта и восстановления доступа.'}
                    </p>
                    ${!emailVerified ? `
                        <button class="btn btn-secondary" onclick="app.resendVerification()">Отправить письмо повторно</button>
                    ` : ''}
                </div>
                <div class="security-section" style="margin-top: 32px;">
                    <h4>Смена пароля</h4>
                    <div class="form-group">
                        <label>Текущий пароль</label>
                        <input type="password" id="current-password" placeholder="Введите текущий пароль">
                    </div>
                    <div class="form-group">
                        <label>Новый пароль</label>
                        <input type="password" id="new-password" placeholder="Введите новый пароль">
                    </div>
                    <div class="form-group">
                        <label>Подтвердите новый пароль</label>
                        <input type="password" id="confirm-password" placeholder="Подтвердите новый пароль">
                    </div>
                    <button class="btn btn-primary" onclick="app.changePassword()">Изменить пароль</button>
                </div>
            </div>
        `;
    }
    
    async loadAudioDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
            const videoInputs = devices.filter(d => d.kind === 'videoinput');
            
            const audioInputSelect = document.getElementById('audio-input-device');
            const audioOutputSelect = document.getElementById('audio-output-device');
            const videoSelect = document.getElementById('video-device');
            
            if (audioInputSelect) {
                audioInputSelect.innerHTML = audioInputs.map(d => 
                    `<option value="${d.deviceId}">${d.label || 'Микрофон ' + (audioInputs.indexOf(d) + 1)}</option>`
                ).join('');
            }
            
            if (audioOutputSelect) {
                audioOutputSelect.innerHTML = audioOutputs.map(d => 
                    `<option value="${d.deviceId}">${d.label || 'Динамики ' + (audioOutputs.indexOf(d) + 1)}</option>`
                ).join('');
            }
            
            if (videoSelect) {
                videoSelect.innerHTML = videoInputs.map(d => 
                    `<option value="${d.deviceId}">${d.label || 'Камера ' + (videoInputs.indexOf(d) + 1)}</option>`
                ).join('');
            }
        } catch (error) {
            console.error('Error loading audio devices:', error);
        }
    }
    
    async saveAccountSettings() {
        const data = {
            username: document.getElementById('settings-username').value,
            about_me: document.getElementById('settings-about').value,
            status: document.getElementById('settings-status').value,
            custom_status: document.getElementById('settings-custom-status').value
        };
        
        try {
            const response = await fetch('/api/user/update', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            });
            
            if (response.ok) {
                await this.loadUser();
                this.showNotification('Настройки сохранены', 'success');
            }
        } catch (error) {
            console.error('Error saving settings:', error);
            this.showNotification('Ошибка при сохранении', 'error');
        }
    }
    
    async handleAvatarUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const formData = new FormData();
        formData.append('avatar', file);
        
        try {
            const response = await fetch('/api/user/avatar', {
                method: 'POST',
                body: formData
            });
            
            if (response.ok) {
                const data = await response.json();
                document.getElementById('settings-avatar-preview').src = `/uploads/${data.avatar}`;
                await this.loadUser();
                this.showNotification('Аватар обновлён', 'success');
            }
        } catch (error) {
            console.error('Error uploading avatar:', error);
            this.showNotification('Ошибка при загрузке аватара', 'error');
        }
    }
    
    async saveAudioSettings() {
        const data = {
            audio_input_device: document.getElementById('audio-input-device').value,
            audio_output_device: document.getElementById('audio-output-device').value,
            video_device: document.getElementById('video-device').value,
            audio_volume: parseInt(document.getElementById('audio-volume').value),
            video_enabled: document.getElementById('video-enabled').checked
        };
        
        try {
            const response = await fetch('/api/user/audio-settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            });
            
            if (response.ok) {
                this.showNotification('Настройки аудио/видео сохранены', 'success');
            }
        } catch (error) {
            console.error('Error saving audio settings:', error);
            this.showNotification('Ошибка при сохранении', 'error');
        }
    }
    
    async addFriendFromSettings() {
        // Проверка подтверждения email
        if (!this.currentUser || !this.currentUser.email_verified) {
            this.showNotification('Для добавления друзей необходимо подтвердить email', 'error');
            return;
        }
        
        const usernameInput = document.getElementById('friend-username');
        const discriminatorInput = document.getElementById('friend-discriminator');
        
        if (!usernameInput || !discriminatorInput) {
            this.showNotification('Поля не найдены', 'error');
            return;
        }
        
        const username = usernameInput.value.trim();
        const discriminator = discriminatorInput.value.trim();
        
        if (!username || !discriminator) {
            this.showNotification('Заполните все поля', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/friends/add', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, discriminator})
            });
            
            const data = await response.json();
            if (response.ok) {
                this.showNotification('Запрос отправлен', 'success');
                // Очищаем поля
                usernameInput.value = '';
                discriminatorInput.value = '';
                // Обновляем списки
                await this.loadFriends();
                await this.loadFriendRequests();
                // Обновляем отображение настроек друзей
                const content = document.getElementById('user-settings-content');
                if (content) {
                    this.showFriendsSettings(content);
                }
            } else {
                this.showNotification(data.error || 'Ошибка', 'error');
            }
        } catch (error) {
            console.error('Error adding friend:', error);
            this.showNotification('Ошибка при отправке запроса', 'error');
        }
    }
    
    async addFriend() {
        const username = document.getElementById('friend-username').value.trim();
        const discriminator = document.getElementById('friend-discriminator').value.trim();
        
        if (!username || !discriminator) {
            this.showNotification('Заполните все поля', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/friends/add', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username, discriminator})
            });
            
            const data = await response.json();
            if (response.ok) {
                this.showNotification('Запрос отправлен', 'success');
                document.getElementById('friend-username').value = '';
                document.getElementById('friend-discriminator').value = '';
                await this.loadFriendRequests();
            } else {
                this.showNotification(data.error || 'Ошибка', 'error');
            }
        } catch (error) {
            console.error('Error adding friend:', error);
            this.showNotification('Ошибка при отправке запроса', 'error');
        }
    }
    
    async acceptFriend(userId) {
        try {
            const response = await fetch('/api/friends/accept', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({user_id: userId})
            });
            
            if (response.ok) {
                await this.loadFriends();
                await this.loadFriendRequests();
                this.showSettingsSection('friends');
                this.showNotification('Запрос принят', 'success');
            }
        } catch (error) {
            console.error('Error accepting friend:', error);
        }
    }
    
    async declineFriend(userId) {
        try {
            const response = await fetch('/api/friends/decline', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({user_id: userId})
            });
            
            if (response.ok) {
                await this.loadFriendRequests();
                this.showSettingsSection('friends');
            }
        } catch (error) {
            console.error('Error declining friend:', error);
        }
    }
    
    renderFriendsList() {
        const container = document.getElementById('friends-list');
        if (!container) return;
        
        if (this.friends.length === 0) {
            container.innerHTML = '<p style="color: var(--text-muted);">У вас пока нет друзей</p>';
            return;
        }
        
        container.innerHTML = this.friends.map(friend => `
            <div class="friend-item">
                <div class="friend-avatar">
                    <img src="${friend.avatar ? `/uploads/${friend.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${friend.username}">
                    <span class="status-indicator ${friend.status || 'offline'}"></span>
                </div>
                <div class="friend-info">
                    <div class="friend-name">${friend.username}</div>
                    <div class="friend-status">${friend.custom_status || friend.status || 'Офлайн'}</div>
                </div>
                <div class="friend-actions">
                    <button class="friend-action-btn" onclick="app.startCall(${friend.id}, 'video')" title="Видеозвонок">
                        <i class="fas fa-video"></i>
                    </button>
                    <button class="friend-action-btn" onclick="app.startCall(${friend.id}, 'audio')" title="Звонок">
                        <i class="fas fa-phone"></i>
                    </button>
                    <button class="friend-action-btn" onclick="app.startCall(${friend.id}, 'screen')" title="Демонстрация экрана">
                        <i class="fas fa-desktop"></i>
                    </button>
                    <button class="friend-action-btn" onclick="app.openDM(${friend.id})" title="Сообщение">
                        <i class="fas fa-comment"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    renderFriendRequests() {
        const container = document.getElementById('friend-requests-list');
        if (!container) return;
        
        if (this.friendRequests.length === 0) {
            container.innerHTML = '<p style="color: var(--text-muted);">Нет входящих запросов</p>';
            return;
        }
        
        container.innerHTML = this.friendRequests.map(req => `
            <div class="friend-item">
                <div class="friend-avatar">
                    <img src="${req.user.avatar ? `/uploads/${req.user.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${req.user.username}">
                </div>
                <div class="friend-info">
                    <div class="friend-name">${req.user.username}#${req.user.discriminator}</div>
                    <div class="friend-status">Хочет добавить вас в друзья</div>
                </div>
                <div class="friend-actions">
                    <button class="friend-action-btn accept" onclick="app.acceptFriend(${req.id})" title="Принять">
                        <i class="fas fa-check"></i>
                    </button>
                    <button class="friend-action-btn decline" onclick="app.declineFriend(${req.id})" title="Отклонить">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    startCall(userId, type = 'video') {
        // Проверка подтверждения email
        if (!this.currentUser || !this.currentUser.email_verified) {
            this.showNotification('Для звонков необходимо подтвердить email', 'error');
            return;
        }
        
        if (!this.webrtcManager) {
            this.showNotification('WebRTC не инициализирован', 'error');
            return;
        }
        
        this.webrtcManager.startCall(userId, type);
        this.showCallModal();
    }
    
    handleIncomingCall(data) {
        this.incomingCall = data;
        const modal = document.getElementById('incoming-call-modal');
        const avatar = document.getElementById('incoming-call-avatar');
        const name = document.getElementById('incoming-call-name');
        
        if (modal && avatar && name) {
            avatar.src = data.from_user.avatar ? `/uploads/${data.from_user.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png';
            name.textContent = data.from_user.username;
            modal.style.display = 'flex';
            
            // Воспроизводим звук входящего звонка
            this.playSound('call');
            
            // Повторяем звук каждые 2 секунды пока звонок активен
            this._callSoundInterval = setInterval(() => {
                if (document.getElementById('incoming-call-modal').style.display !== 'none') {
                    this.playSound('call');
                } else {
                    clearInterval(this._callSoundInterval);
                }
            }, 2000);
        }
    }
    
    async acceptIncomingCall() {
        if (!this.incomingCall || !this.webrtcManager) return;
        
        document.getElementById('incoming-call-modal').style.display = 'none';
        await this.webrtcManager.acceptIncomingCall();
        this.showCallModal();
        this.incomingCall = null;
    }
    
    declineIncomingCall() {
        if (this.webrtcManager) {
            this.webrtcManager.endCall();
        }
        document.getElementById('incoming-call-modal').style.display = 'none';
        this.incomingCall = null;
        
        // Останавливаем звук входящего звонка
        if (this._callSoundInterval) {
            clearInterval(this._callSoundInterval);
            this._callSoundInterval = null;
        }
    }
    
    showCallModal() {
        document.getElementById('call-modal').style.display = 'block';
    }
    
    endCall() {
        if (this.webrtcManager) {
            this.webrtcManager.endCall();
        }
        document.getElementById('call-modal').style.display = 'none';
        document.getElementById('incoming-call-modal').style.display = 'none';
        
        // Останавливаем звук входящего звонка
        if (this._callSoundInterval) {
            clearInterval(this._callSoundInterval);
            this._callSoundInterval = null;
        }
    }
    
    toggleCallMute() {
        if (this.webrtcManager) {
            const muted = this.webrtcManager.toggleMute();
            const btn = document.getElementById('mute-call-btn');
            if (btn) {
                btn.classList.toggle('muted', muted);
            }
        }
    }
    
    toggleCallVideo() {
        if (this.webrtcManager) {
            const disabled = this.webrtcManager.toggleVideo();
            const btn = document.getElementById('video-call-btn');
            if (btn) {
                btn.classList.toggle('disabled', disabled);
            }
        }
    }
    
    async toggleScreenShare() {
        if (!this.webrtcManager) return;
        
        const btn = document.getElementById('screen-share-btn');
        const isSharing = btn?.classList.contains('active');
        
        if (isSharing) {
            // Останавливаем демонстрацию экрана
            if (this.webrtcManager.localStream) {
                const videoTrack = this.webrtcManager.localStream.getVideoTracks()[0];
                if (videoTrack && videoTrack.label.includes('Screen')) {
                    videoTrack.stop();
                    // Переключаемся обратно на камеру
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                        const oldVideoTrack = this.webrtcManager.localStream.getVideoTracks()[0];
                        const newVideoTrack = stream.getVideoTracks()[0];
                        if (oldVideoTrack && newVideoTrack) {
                            this.webrtcManager.peerConnection.removeTrack(oldVideoTrack);
                            this.webrtcManager.localStream.removeTrack(oldVideoTrack);
                            this.webrtcManager.localStream.addTrack(newVideoTrack);
                            this.webrtcManager.peerConnection.addTrack(newVideoTrack, this.webrtcManager.localStream);
                        }
                        stream.getAudioTracks().forEach(track => track.stop());
                    } catch (error) {
                        console.error('Error switching back to camera:', error);
                    }
                }
            }
            btn?.classList.remove('active');
        } else {
            // Начинаем демонстрацию экрана
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                const oldVideoTrack = this.webrtcManager.localStream?.getVideoTracks()[0];
                const newVideoTrack = screenStream.getVideoTracks()[0];
                
                if (oldVideoTrack && newVideoTrack && this.webrtcManager.peerConnection) {
                    // Заменяем трек
                    const sender = this.webrtcManager.peerConnection.getSenders().find(s => 
                        s.track && s.track.kind === 'video'
                    );
                    if (sender) {
                        await sender.replaceTrack(newVideoTrack);
                    }
                    
                    // Обновляем локальный поток
                    if (this.webrtcManager.localStream) {
                        this.webrtcManager.localStream.removeTrack(oldVideoTrack);
                        this.webrtcManager.localStream.addTrack(newVideoTrack);
                    }
                    
                    // Обновляем видео элемент
                    const localVideo = document.getElementById('local-video');
                    if (localVideo && this.webrtcManager.localStream) {
                        localVideo.srcObject = this.webrtcManager.localStream;
                    }
                    
                    // Обработка завершения демонстрации
                    newVideoTrack.onended = () => {
                        this.toggleScreenShare();
                    };
                    
                    btn?.classList.add('active');
                }
            } catch (error) {
                console.error('Error starting screen share:', error);
                this.showNotification('Не удалось начать демонстрацию экрана', 'error');
            }
        }
    }
    
    async enable2FA() {
        try {
            const response = await fetch('/api/user/2fa/enable', {method: 'POST'});
            const data = await response.json();
            
            if (response.ok) {
                this.show2FAModal(data);
            } else {
                this.showNotification(data.error || 'Ошибка при включении 2FA', 'error');
            }
        } catch (error) {
            console.error('Error enabling 2FA:', error);
            this.showNotification('Ошибка при включении 2FA', 'error');
        }
    }
    
    show2FAModal(data) {
        const existingModal = document.getElementById('2fa-modal');
        if (existingModal) {
            existingModal.remove();
        }
        
        const overlay = document.getElementById('modal-overlay');
        const modal = document.createElement('div');
        modal.id = '2fa-modal';
        modal.className = 'modal modal-large';
        modal.innerHTML = `
            <div class="modal-header">
                <h2>Включить двухфакторную аутентификацию</h2>
                <button class="modal-close" onclick="app.close2FAModal()"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body">
                <div class="qr-code-container">
                    <img src="${data.qr_code}" alt="QR Code" style="max-width: 256px; border-radius: 8px;">
                    <p style="margin-top: 16px; color: var(--text-muted);">Отсканируйте QR-код в приложении-аутентификаторе (Google Authenticator, Authy и т.д.)</p>
                </div>
                <div class="backup-codes" style="margin-top: 24px;">
                    <h4>Резервные коды (сохраните их в безопасном месте!)</h4>
                    <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 12px;">Эти коды можно использовать для входа, если вы потеряете доступ к приложению-аутентификатору.</p>
                    <div class="backup-codes-list">
                        ${data.backup_codes.map(code => `<div class="backup-code">${code}</div>`).join('')}
                    </div>
                </div>
                <div class="form-group" style="margin-top: 24px;">
                    <label>Введите код для подтверждения</label>
                    <input type="text" id="2fa-verify-code" placeholder="000000" maxlength="6" style="width: 100%; padding: 10px; font-size: 18px; text-align: center; letter-spacing: 4px;">
                    <p style="color: var(--text-muted); font-size: 12px; margin-top: 8px;">Введите 6-значный код из приложения-аутентификатора</p>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="app.close2FAModal()">Отмена</button>
                <button class="btn btn-primary" onclick="app.verify2FA()">Подтвердить и включить</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.classList.add('active');
        }
        modal.style.display = 'flex';
        modal.classList.add('active');
    }
    
    close2FAModal() {
        const modal = document.getElementById('2fa-modal');
        const overlay = document.getElementById('modal-overlay');
        if (modal) modal.remove();
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        }
    }
    
    async verify2FA() {
        const codeInput = document.getElementById('2fa-verify-code');
        if (!codeInput) return;
        
        const code = codeInput.value.trim();
        if (!code || code.length !== 6) {
            this.showNotification('Введите 6-значный код', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/user/2fa/verify', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({token: code})
            });
            
            const data = await response.json();
            if (response.ok) {
                await this.loadUser();
                this.showNotification('2FA успешно включена', 'success');
                this.close2FAModal();
                this.showSettingsSection('security');
            } else {
                this.showNotification(data.error || 'Неверный код', 'error');
            }
        } catch (error) {
            console.error('Error verifying 2FA:', error);
            this.showNotification('Ошибка при проверке кода', 'error');
        }
    }
    
    async disable2FA() {
        const password = prompt('Введите пароль для отключения 2FA:');
        if (!password) return;
        
        try {
            const response = await fetch('/api/user/2fa/disable', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({password})
            });
            
            const data = await response.json();
            if (response.ok) {
                await this.loadUser();
                this.showNotification('2FA успешно отключена', 'success');
                this.showSettingsSection('security');
            } else {
                this.showNotification(data.error || 'Неверный пароль', 'error');
            }
        } catch (error) {
            console.error('Error disabling 2FA:', error);
            this.showNotification('Ошибка при отключении 2FA', 'error');
        }
    }
    
    async resendVerification() {
        try {
            // Показываем индикатор загрузки
            const btn = event?.target || document.querySelector('button[onclick*="resendVerification"]');
            const originalText = btn?.textContent;
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Отправка...';
            }
            
            const response = await fetch('/api/user/resend-verification', {method: 'POST'});
            const data = await response.json();
            
            if (response.ok) {
                this.showNotification('✓ Письмо отправлено на ваш email. Проверьте папку "Входящие" и "Спам".', 'success');
            } else {
                let errorMsg = data.error || 'Ошибка при отправке письма';
                // Если это ошибка настройки email, показываем более понятное сообщение
                if (errorMsg.includes('настройки email') || errorMsg.includes('MAIL_USERNAME')) {
                    errorMsg = 'Email не настроен. Обратитесь к администратору или настройте SMTP в app.py';
                }
                this.showNotification(errorMsg, 'error');
                console.error('Email error:', data);
            }
            
            if (btn) {
                btn.disabled = false;
                if (originalText) btn.textContent = originalText;
            }
        } catch (error) {
            console.error('Error resending verification:', error);
            this.showNotification('Ошибка при отправке письма. Проверьте консоль браузера (F12).', 'error');
            const btn = event?.target || document.querySelector('button[onclick*="resendVerification"]');
            if (btn) {
                btn.disabled = false;
            }
        }
    }
    
    async changePassword() {
        const currentPassword = document.getElementById('current-password')?.value;
        const newPassword = document.getElementById('new-password')?.value;
        const confirmPassword = document.getElementById('confirm-password')?.value;
        
        if (!currentPassword || !newPassword || !confirmPassword) {
            this.showNotification('Заполните все поля', 'error');
            return;
        }
        
        if (newPassword.length < 8) {
            this.showNotification('Пароль должен содержать минимум 8 символов', 'error');
            return;
        }
        
        if (newPassword !== confirmPassword) {
            this.showNotification('Новые пароли не совпадают', 'error');
            return;
        }
        
        try {
            const response = await fetch('/api/user/change-password', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    current_password: currentPassword,
                    new_password: newPassword
                })
            });
            
            const data = await response.json();
            if (response.ok) {
                this.showNotification('Пароль успешно изменён', 'success');
                // Очищаем поля
                document.getElementById('current-password').value = '';
                document.getElementById('new-password').value = '';
                document.getElementById('confirm-password').value = '';
            } else {
                this.showNotification(data.error || 'Ошибка при смене пароля', 'error');
            }
        } catch (error) {
            console.error('Error changing password:', error);
            this.showNotification('Ошибка при смене пароля', 'error');
        }
    }
    
    async testMicrophone() {
        const btn = document.getElementById('test-mic-btn');
        const result = document.getElementById('mic-test-result');
        
        if (!btn || !result) return;
        
        if (btn.textContent.includes('Остановить')) {
            // Останавливаем тест
            if (this._testStream) {
                this._testStream.getTracks().forEach(track => track.stop());
                this._testStream = null;
            }
            btn.textContent = 'Тест микрофона';
            result.innerHTML = '';
            return;
        }
        
        btn.textContent = 'Остановить тест';
        result.innerHTML = '<p style="color: var(--text-muted);">Проверка микрофона...</p>';
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this._testStream = stream;
            
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const analyser = audioContext.createAnalyser();
            const microphone = audioContext.createMediaStreamSource(stream);
            microphone.connect(analyser);
            
            analyser.fftSize = 256;
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            
            const checkLevel = () => {
                if (!this._testStream) return;
                
                analyser.getByteFrequencyData(dataArray);
                const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
                const level = Math.round((average / 255) * 100);
                
                result.innerHTML = `
                    <div style="margin-top: 8px;">
                        <div style="background: var(--bg-tertiary); height: 20px; border-radius: 4px; overflow: hidden;">
                            <div style="background: ${level > 50 ? 'var(--success)' : level > 25 ? 'var(--warning)' : 'var(--text-muted)'}; height: 100%; width: ${level}%; transition: width 0.1s;"></div>
                        </div>
                        <p style="color: var(--text-muted); font-size: 12px; margin-top: 4px;">Уровень: ${level}%</p>
                    </div>
                `;
                
                if (this._testStream) {
                    requestAnimationFrame(checkLevel);
                }
            };
            
            checkLevel();
            result.innerHTML = '<p style="color: var(--success);">Микрофон работает!</p>';
        } catch (error) {
            console.error('Error testing microphone:', error);
            result.innerHTML = '<p style="color: var(--text-danger);">Ошибка доступа к микрофону</p>';
            btn.textContent = 'Тест микрофона';
        }
    }
    
    async openDM(userId) {
        // Переключиться на DM с пользователем
        await this.showDMs();
        
        // Найти пользователя в друзьях или в списке DM
        const friend = this.friends.find(f => f.id === userId);
        if (friend) {
            // Используем selectDM напрямую
            await this.selectDM(friend);
        } else {
            // Если пользователь не в друзьях, загружаем его данные
            try {
                const response = await fetch(`/api/user/${userId}`);
                if (response.ok) {
                    const user = await response.json();
                    await this.selectDM(user);
                }
            } catch (error) {
                console.error('Error loading user for DM:', error);
                this.showNotification('Не удалось открыть чат', 'error');
            }
        }
    }
    
    showDevicesSettings(container) {
        if (!this.currentUser) {
            container.innerHTML = '<div class="settings-section"><p style="padding: 20px; text-align: center;">Загрузка данных пользователя...</p></div>';
            this.loadUser().then(() => {
                if (this.currentUser) {
                    this.showDevicesSettings(container);
                }
            });
            return;
        }
        
        container.innerHTML = '<div class="settings-section"><p style="padding: 20px; text-align: center;">Загрузка устройств...</p></div>';
        
        fetch('/api/user/devices')
            .then(r => r.json())
            .catch(() => [])
            .then(devices => {
                if (!devices) devices = [];
                
                const formatDate = (dateStr) => {
                    if (!dateStr) return 'Неизвестно';
                    try {
                        const date = new Date(dateStr);
                        return date.toLocaleString('ru-RU', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                    } catch {
                        return dateStr;
                    }
                };
                
                container.innerHTML = `
                    <div class="settings-section">
                        <h3>Устройства</h3>
                        <p style="color: var(--text-muted); margin-bottom: 20px;">
                            Здесь отображаются все устройства, на которых вы вошли в свой аккаунт. Вы можете выйти из любого устройства.
                        </p>
                        <div class="devices-list">
                            ${devices.length === 0 ? '<p style="color: var(--text-muted); padding: 20px;">Устройства не найдены</p>' : ''}
                            ${devices.map(device => `
                                <div class="device-item ${device.is_current ? 'current-device' : ''}">
                                    <div class="device-info">
                                        <div class="device-icon">
                                            <i class="fas fa-${device.is_current ? 'desktop' : 'mobile-alt'}"></i>
                                        </div>
                                        <div class="device-details">
                                            <div class="device-name">
                                                ${device.device_name}
                                                ${device.is_current ? '<span class="current-badge">Текущее устройство</span>' : ''}
                                            </div>
                                            <div class="device-meta">
                                                <span>IP: ${device.ip_address}</span>
                                                <span>•</span>
                                                <span>Последняя активность: ${formatDate(device.last_activity)}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="device-actions">
                                        ${!device.is_current ? `
                                            <button class="btn btn-danger btn-sm" onclick="app.deleteDevice('${device.session_id}')">
                                                <i class="fas fa-sign-out-alt"></i> Выйти
                                            </button>
                                        ` : '<span style="color: var(--text-muted); font-size: 12px;">Текущее устройство</span>'}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
    }
    
    async deleteDevice(sessionId) {
        if (!confirm('Вы уверены, что хотите выйти из этого устройства?')) {
            return;
        }
        
        try {
            const response = await fetch(`/api/user/devices/${sessionId}/delete`, {
                method: 'POST'
            });
            
            const data = await response.json();
            if (response.ok) {
                this.showNotification('Устройство удалено', 'success');
                this.showSettingsSection('devices');
            } else {
                this.showNotification(data.error || 'Ошибка при удалении устройства', 'error');
            }
        } catch (error) {
            console.error('Error deleting device:', error);
            this.showNotification('Ошибка при удалении устройства', 'error');
        }
    }
    
    // Utility Functions
    showWelcomeMessage() {
        const container = document.getElementById('messages-container');
        if (container) {
            container.innerHTML = '<div class="welcome-message"><h2>Добро пожаловать!</h2><p>Выберите канал для начала общения</p></div>';
        }
        
        const messageForm = document.getElementById('message-form');
        if (messageForm) messageForm.style.display = 'none';
    }
    
    toggleMembersList() {
        const sidebar = document.getElementById('members-sidebar');
        if (sidebar) {
            sidebar.style.display = sidebar.style.display === 'none' ? 'block' : 'none';
        }
    }
    
    showPinnedMessages() {
        if (!this.currentChannel) return;
        
        fetch(`/api/channels/${this.currentChannel.id}/pins`)
            .then(r => r.json())
            .then(messages => {
                // Show pinned messages modal
                console.log('Pinned messages:', messages);
            });
    }
    
    closeModal() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.remove('active');
            modal.style.display = 'none';
            modal.style.zIndex = '';
            modal.style.pointerEvents = '';
        });
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
            overlay.style.pointerEvents = '';
        }
    }
    
    hideContextMenu() {
        const menu = document.getElementById('context-menu');
        if (menu) menu.style.display = 'none';
    }
    
    playSound(soundName = 'notification') {
        try {
            const audio = new Audio(`/static/sounds/${soundName}.wav`);
            audio.volume = 0.5;
            audio.play().catch(err => console.log('Could not play sound:', err));
        } catch (error) {
            console.log('Error playing sound:', error);
        }
    }
    
    showNotification(message, type = 'info') {
        const container = document.getElementById('notifications-container');
        if (!container) return;
        
        // Воспроизводим звук для уведомлений
        if (type === 'success' || type === 'error') {
            this.playSound('notification');
        }
        
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <div class="notification-title">${type === 'error' ? 'Ошибка' : type === 'success' ? 'Успешно' : 'Уведомление'}</div>
            <div class="notification-message">${message}</div>
        `;
        
        container.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }
    
    toggleMute() {
        const btn = document.getElementById('mute-btn');
        if (btn) {
            btn.classList.toggle('muted');
        }
    }
    
    toggleDeafen() {
        const btn = document.getElementById('deafen-btn');
        if (btn) {
            btn.classList.toggle('muted');
        }
    }
    
    async logout() {
        window.location.href = '/logout';
    }
    
    autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
}

// Initialize app when DOM is ready
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new DiscordApp();
});

// Make app globally available
window.app = app;

