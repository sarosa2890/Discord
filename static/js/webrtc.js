// WebRTC для звонков, видеозвонков и демонстрации экрана
class WebRTCManager {
    constructor(socket) {
        this.socket = socket;
        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.isCallActive = false;
        this.callType = null; // 'audio', 'video', 'screen'
        this.targetUserId = null;
        this.pendingOffer = null;
        this.pendingIceCandidates = []; // Кэш для ICE кандидатов до установки remote description
        this.iceCandidateQueue = []; // Очередь для батчинга ICE кандидатов
        this.iceCandidateTimer = null; // Таймер для отправки батча
        
        this.setupSocketListeners();
        // Peer connection будет создан при начале звонка
        this.peerConnection = null;
    }
    
    setupSocketListeners() {
        this.socket.on('webrtc_offer', (data) => {
            this.handleOffer(data);
        });
        
        this.socket.on('webrtc_answer', (data) => {
            this.handleAnswer(data);
        });
        
        this.socket.on('webrtc_ice_candidate', (data) => {
            this.handleIceCandidate(data);
        });
        
        this.socket.on('webrtc_end_call', (data) => {
            this.endCall();
        });
    }
    
    setupRTCPeerConnection() {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
        
        this.peerConnection = new RTCPeerConnection(configuration);
        
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.targetUserId) {
                // Батчинг ICE кандидатов для снижения сетевой нагрузки
                this.iceCandidateQueue.push(event.candidate);
                
                // Отправляем батч каждые 500мс или при накоплении 5 кандидатов
                clearTimeout(this.iceCandidateTimer);
                if (this.iceCandidateQueue.length >= 5) {
                    this.sendIceCandidateBatch();
                } else {
                    this.iceCandidateTimer = setTimeout(() => {
                        this.sendIceCandidateBatch();
                    }, 500);
                }
            }
        };
        
        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', this.peerConnection.iceConnectionState);
        };
        
        this.peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', this.peerConnection.connectionState);
        };
        
        this.peerConnection.ontrack = (event) => {
            console.log('Received remote track:', event.track.kind, event.streams, event.track);
            if (event.streams && event.streams.length > 0) {
                this.remoteStream = event.streams[0];
                console.log('Remote stream from event.streams:', this.remoteStream);
            } else if (event.track) {
                // Если streams пустой, создаём новый MediaStream
                if (!this.remoteStream) {
                    this.remoteStream = new MediaStream();
                }
                this.remoteStream.addTrack(event.track);
                console.log('Added track to remote stream:', this.remoteStream);
            }
            
            // Проверяем что треки есть в потоке
            if (this.remoteStream) {
                console.log('Remote stream tracks:', this.remoteStream.getTracks());
                this.remoteStream.getTracks().forEach(track => {
                    console.log('Track:', track.kind, track.enabled, track.readyState);
                    track.onended = () => console.log('Track ended:', track.kind);
                });
            }
            
            this.displayRemoteStream();
        };
    }
    
    async startCall(userId, type = 'video') {
        if (this.isCallActive) {
            console.log('Call already active');
            return;
        }
        
        this.targetUserId = userId;
        this.callType = type;
        this.isCallActive = true;
        
        // Создаём новый peer connection для каждого звонка
        this.setupRTCPeerConnection();
        
        try {
            // Получаем локальный поток
            if (type === 'screen') {
                this.localStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });
            } else {
                // Всегда запрашиваем видео для отображения
                const constraints = {
                    audio: true,
                    video: true // Всегда запрашиваем видео
                };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            }
            
            console.log('Local stream obtained:', this.localStream.getTracks());
            
            // Добавляем треки в peer connection
            this.localStream.getTracks().forEach(track => {
                console.log('Adding local track:', track.kind, track.id);
                this.peerConnection.addTrack(track, this.localStream);
            });
            
            // Отображаем локальный поток
            this.displayLocalStream();
            
            // Создаем offer с явным указанием что хотим получать аудио и видео
            const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            console.log('Created offer:', offer);
            await this.peerConnection.setLocalDescription(offer);
            console.log('Local description set');
            
            // Отправляем offer
            this.socket.emit('webrtc_offer', {
                target_user_id: userId,
                offer: offer,
                call_type: type
            });
            console.log('Offer sent to user:', userId, 'type:', type);
            
            // Обработка завершения стрима (для демонстрации экрана)
            if (type === 'screen') {
                this.localStream.getVideoTracks()[0].onended = () => {
                    this.endCall();
                };
            }
            
        } catch (error) {
            console.error('Error starting call:', error);
            this.endCall();
        }
    }
    
    async handleOffer(data) {
        if (this.isCallActive) {
            return; // Уже в звонке
        }
        
        console.log('Received offer:', data);
        this.targetUserId = data.from_user_id;
        this.callType = data.call_type || 'video'; // Определяем тип звонка из данных
        this.pendingOffer = data.offer;
        
        console.log('Call type:', this.callType, 'from user:', data.from_user_id);
        
        // Создаём новый peer connection для входящего звонка
        this.setupRTCPeerConnection();
        
        // Показываем уведомление о входящем звонке
        this.showIncomingCall(data.from_user);
        
        // НЕ принимаем автоматически - ждём действия пользователя
    }
    
    async acceptIncomingCall() {
        if (!this.targetUserId || !this.pendingOffer) return;
        
        this.isCallActive = true;
        await this.acceptCall(this.pendingOffer);
        this.pendingOffer = null;
    }
    
    async acceptCall(offer) {
        try {
            if (!offer && this.pendingOffer) {
                offer = this.pendingOffer;
            }
            
            if (!offer) {
                console.error('No offer to accept');
                return;
            }
            
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            console.log('Remote description set from offer');
            
            // Добавляем кэшированные ICE кандидаты
            await this.addPendingIceCandidates();
            
            // Получаем локальный поток
            // Всегда запрашиваем видео, даже если звонок audio (для отображения)
            const constraints = {
                audio: true,
                video: true // Всегда запрашиваем видео
            };
            console.log('Getting local media with constraints:', constraints);
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Local stream obtained:', this.localStream.getTracks());
            
            this.localStream.getTracks().forEach(track => {
                console.log('Adding local track:', track.kind, track.id);
                this.peerConnection.addTrack(track, this.localStream);
            });
            
            this.displayLocalStream();
            
            // Создаем answer
            const answer = await this.peerConnection.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            console.log('Created answer:', answer);
            await this.peerConnection.setLocalDescription(answer);
            console.log('Local description set for answer');
            
            // Отправляем answer
            this.socket.emit('webrtc_answer', {
                target_user_id: this.targetUserId,
                answer: answer
            });
            console.log('Answer sent to user:', this.targetUserId);
            
        } catch (error) {
            console.error('Error accepting call:', error);
            this.endCall();
        }
    }
    
    async handleAnswer(data) {
        console.log('Received answer:', data);
        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            console.log('Remote description set from answer');
            
            // Добавляем кэшированные ICE кандидаты
            await this.addPendingIceCandidates();
        } catch (error) {
            console.error('Error setting remote description from answer:', error);
        }
    }
    
    async handleIceCandidate(data) {
        // Поддержка батчинга кандидатов
        const candidates = data.candidates || (data.candidate ? [data.candidate] : []);
        if (candidates.length === 0) return;
        
        // Если remote description ещё не установлен, кэшируем кандидаты
        if (!this.peerConnection || this.peerConnection.remoteDescription === null) {
            console.log('Remote description not set yet, caching ICE candidates');
            this.pendingIceCandidates.push(...candidates);
            return;
        }
        
        // Добавляем все кандидаты
        for (const candidate of candidates) {
            try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('ICE candidate added successfully');
            } catch (error) {
                console.error('Error adding ICE candidate:', error);
            }
        }
    }
    
    async addPendingIceCandidates() {
        if (this.pendingIceCandidates.length > 0) {
            console.log(`Adding ${this.pendingIceCandidates.length} pending ICE candidates`);
            for (const candidate of this.pendingIceCandidates) {
                try {
                    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    console.log('Pending ICE candidate added successfully');
                } catch (error) {
                    console.error('Error adding pending ICE candidate:', error);
                }
            }
            this.pendingIceCandidates = [];
        }
    }
    
    displayLocalStream() {
        const video = document.getElementById('local-video');
        if (video) {
            video.srcObject = this.localStream;
            video.play();
        }
    }
    
    displayRemoteStream() {
        const video = document.getElementById('remote-video');
        if (video && this.remoteStream) {
            console.log('Displaying remote stream:', this.remoteStream);
            video.srcObject = this.remoteStream;
            
            video.onloadedmetadata = () => {
                console.log('Remote video metadata loaded');
                video.play().catch(err => {
                    console.error('Error playing remote video:', err);
                });
            };
            
            video.onplay = () => {
                console.log('Remote video started playing');
            };
            
            // Принудительно запускаем воспроизведение
            video.play().catch(err => {
                console.error('Error playing remote video:', err);
            });
            
            // Убеждаемся что видео видимо
            video.style.display = 'block';
            video.style.opacity = '1';
        } else {
            console.error('Video element or remote stream not found', {video, stream: this.remoteStream});
        }
    }
    
    showIncomingCall(user) {
        // Используем существующее модальное окно из app.html
        const modal = document.getElementById('incoming-call-modal');
        const avatar = document.getElementById('incoming-call-avatar');
        const name = document.getElementById('incoming-call-name');
        
        if (modal && avatar && name) {
            avatar.src = user.avatar ? `/uploads/${user.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png';
            name.textContent = user.username;
            modal.style.display = 'flex';
        } else {
            // Fallback: создаём модальное окно, если его нет
            const fallbackModal = document.createElement('div');
            fallbackModal.className = 'call-modal incoming-call';
            fallbackModal.id = 'incoming-call-modal-fallback';
            fallbackModal.innerHTML = `
                <div class="call-content">
                    <div class="call-user-info">
                        <img src="${user.avatar ? `/uploads/${user.avatar}` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${user.username}">
                        <h3>${user.username}</h3>
                        <p>Входящий звонок</p>
                    </div>
                    <div class="call-buttons">
                        <button class="btn-call accept" onclick="webrtcManager.acceptIncomingCall()">
                            <i class="fas fa-phone"></i>
                        </button>
                        <button class="btn-call decline" onclick="webrtcManager.endCall()">
                            <i class="fas fa-phone-slash"></i>
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(fallbackModal);
        }
    }
    
    endCall() {
        console.log('Ending call');
        this.isCallActive = false;
        this.targetUserId = null;
        this.callType = null;
        this.pendingOffer = null;
        this.pendingIceCandidates = []; // Очищаем кэш ICE кандидатов
        
        // Останавливаем все треки
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                console.log('Stopping local track:', track.kind);
                track.stop();
            });
            this.localStream = null;
        }
        
        if (this.remoteStream) {
            this.remoteStream.getTracks().forEach(track => {
                console.log('Stopping remote track:', track.kind);
                track.stop();
            });
            this.remoteStream = null;
        }
        
        // Закрываем peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        
        // Очищаем видео элементы
        const localVideo = document.getElementById('local-video');
        const remoteVideo = document.getElementById('remote-video');
        if (localVideo) {
            localVideo.srcObject = null;
            localVideo.pause();
        }
        if (remoteVideo) {
            remoteVideo.srcObject = null;
            remoteVideo.pause();
        }
        
        console.log('Call ended');
        
        // Удаляем модальное окно
        const callModal = document.querySelector('.call-modal');
        if (callModal) {
            callModal.remove();
        }
        
        // Уведомляем другого пользователя
        if (this.targetUserId) {
            this.socket.emit('webrtc_end_call', {
                target_user_id: this.targetUserId
            });
        }
        
        this.targetUserId = null;
        
        // Очищаем очередь ICE кандидатов
        this.iceCandidateQueue = [];
        clearTimeout(this.iceCandidateTimer);
    }
    
    // Отправка батча ICE кандидатов для оптимизации сети
    sendIceCandidateBatch() {
        if (this.iceCandidateQueue.length === 0 || !this.targetUserId) return;
        
        // Отправляем все кандидаты одним запросом
        this.socket.emit('webrtc_ice_candidate', {
            target_user_id: this.targetUserId,
            candidates: this.iceCandidateQueue // Отправляем массив вместо одного
        });
        
        this.iceCandidateQueue = [];
    }
    
    toggleMute() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                return !audioTrack.enabled;
            }
        }
        return false;
    }
    
    toggleVideo() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                return !videoTrack.enabled;
            }
        }
        return false;
    }
}

// Экспорт для использования в app.js
window.WebRTCManager = WebRTCManager;

