import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { 
    getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut 
} from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { 
    getFirestore, doc, getDoc, setDoc, collection, addDoc, getDocs, Timestamp, query, where, updateDoc, deleteDoc, increment, arrayUnion, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// ============================================================
// ⚠️ INSERT YOUR FIREBASE CONFIG HERE ⚠️
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyBqiPZhA8b5DZg6zpKjN7zv5ukhHNUJgPE",
    authDomain: "linguaverse-globaledition.firebaseapp.com",
    projectId: "linguaverse-globaledition",
    storageBucket: "linguaverse-globaledition.firebasestorage.app",
    messagingSenderId: "431419000166",
    appId: "1:431419000166:web:0d08ef1a1299a7075ff4a7"
};

let app, auth, db;
let currentUser = null; 
let currentUserData = null;
let stripe, elements, cardElement;

let currentEditingNovelId = null; 
let currentEditingChapterId = null; 
const EXCHANGE_RATE_USD_THB = 34; 

// --- REVENUE CONFIGURATION ---
const SHARE_RATE_TH = 0.70; // 70% (New Rate)
const SHARE_RATE_EN = 0.80; // 80% (New Rate)
const TAX_RATE = 0; // 0% for now (can change to 0.03 later)

// ตัวแปรสำหรับเก็บรายการตอนที่กำลังอ่าน
let currentNovelChapters = [];

// ============================================================
//  1. CORE UTILS
// ============================================================

function showJunkCodeWarning() {
    Swal.fire({
        icon: 'warning',
        title: 'พบการวางแบบผิดวิธี!',
        text: 'กรุณาใช้ Ctrl+Shift+V เพื่อวางข้อความ (ป้องกันหน้าเว็บพัง)',
        confirmButtonColor: '#0ea5e9'
    });
}

function setupJunkCodeProtection(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !e.shiftKey) {
            e.preventDefault();
            showJunkCodeWarning();
        }
    });
}

window.showPage = function(pageId) {
    console.log("Showing page:", pageId); // Debug
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    const activePage = document.getElementById(pageId);
    if (activePage) activePage.classList.add('active');
    
    // Page Init Logic
    if (pageId === 'page-admin-add-novel') {
        loadNovelsForDropdown('edit-novel-select');
        if(!currentEditingNovelId) window.setAdminNovelMode('add');
        setupJunkCodeProtection('novel-description-editor');
    }
    if (pageId === 'page-admin-add-chapter') {
        loadNovelsForDropdown('chapter-novel-select');
        window.setAdminChapterMode('add'); 
        setupJunkCodeProtection('chapter-content-editor');
    }
    
    // เรียก Dashboard อย่างระมัดระวัง
    if (pageId === 'page-writer-dashboard') {
        if(currentUser) {
            window.loadWriterDashboard();
        } else {
            Swal.fire('กรุณาล็อกอิน', 'ต้องล็อกอินก่อนเข้าใช้งาน', 'warning');
            window.showPage('page-login');
        }
    }

    if (pageId === 'page-writer-withdraw') {
        if(currentUser) {
            window.loadWriterWithdraw(); // โหลดข้อมูลการเงินแบบละเอียด
        }
    }

    // ⭐ Load Admin Topup (Withdrawal + Point Topup Requests)
    if (pageId === 'page-admin-topup') {
        if(currentUserData && currentUserData.role === 'admin') {
            window.loadAdminWithdrawals(); // โหลดคำร้องถอนเงิน (ซึ่งจะเรียกโหลด Topup ต่อ)
        } else {
            Swal.fire('Restricted', 'เฉพาะผู้ดูแลระบบเท่านั้น', 'error');
            window.showPage('page-home');
        }
    }

    // เรียกหน้า Notifications
    if (pageId === 'page-admin-notifications') {
        if(currentUser) {
            window.loadNotifications();
        } else {
            Swal.fire('กรุณาล็อกอิน', 'ต้องล็อกอินก่อนเข้าใช้งาน', 'warning');
            window.showPage('page-login');
        }
    }
    
    // เรียกหน้า Topup และ Setup Stripe
    if (pageId === 'page-add-point') {
        if(currentUser) {
            document.getElementById('point-username').value = currentUserData.username || currentUser.email;
            window.setupStripe();
            window.loadUserPendingTopups(); // ⭐ โหลดสถานะรายการเติม Point ของผู้ใช้
        } else {
            Swal.fire('Login Required', 'Please login to buy points.', 'warning');
            window.showPage('page-login');
        }
    }

    if (window.scrollToTop) window.scrollToTop();
    if (window.lucide) window.lucide.createIcons();
}

window.logout = function() { 
    signOut(auth).then(() => {
        currentUser = null;
        currentUserData = null;
        window.showPage('page-home');
        setTimeout(() => window.location.reload(), 500); // รีโหลดเพื่อล้างค่า
    });
}

// ============================================================
//  2. DATA HANDLING
// ============================================================
window.setupStripe = function() {
    // เช็คว่าเคยสร้างไปแล้วหรือยัง ป้องกันการสร้างซ้ำ
    if (cardElement) {
        // ถ้ามีแล้ว ให้ clear ค่าข้างใน
        cardElement.clear();
        return;
    }

    if (window.Stripe) {
        // Key นี้เป็น Test Key สาธารณะของ Stripe สามารถใช้ทดสอบได้จริง
        stripe = Stripe('pk_test_TYooMQauvdEDq54NiTphI7jx');
        elements = stripe.elements();
        
        // Custom Style ให้เข้ากับ Theme
        const style = {
            base: {
                color: "#32325d",
                fontFamily: '"Inter", sans-serif',
                fontSmoothing: "antialiased",
                fontSize: "16px",
                "::placeholder": {
                    color: "#aab7c4"
                }
            },
            invalid: {
                color: "#fa755a",
                iconColor: "#fa755a"
            }
        };

        cardElement = elements.create('card', { style: style });
        cardElement.mount('#card-element');
    }
}

// ⭐ NEW: Load Pending Topups for Regular Users
window.loadUserPendingTopups = async function() {
    const container = document.getElementById('topup-pending-status');
    if (!container || !currentUser) return;

    try {
        const q = query(
            collection(db, "transactions"), 
            where("userId", "==", currentUser.uid), 
            where("status", "==", "pending"), 
            orderBy("timestamp", "desc")
        );
        const snap = await getDocs(q);

        if (snap.empty) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        container.classList.remove('hidden');
        container.innerHTML = `
            <div class="bg-yellow-50 text-yellow-800 p-4 rounded-xl border border-yellow-200 mb-6 flex items-center gap-3">
                <i data-lucide="clock" class="w-6 h-6 flex-shrink-0"></i>
                <div class="text-sm">
                    <p class="font-bold">Pending Top-up Request(s):</p>
                    ${snap.docs.map(docSnap => {
                        const tx = docSnap.data();
                        const timeStr = tx.timestamp ? new Date(tx.timestamp.toDate()).toLocaleString('en-US', {hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric'}) : 'N/A';
                        return `<p class="mt-1">Order #${docSnap.id.substring(0, 5)}...: ${tx.pointsAdded} Points ($${tx.amountUSD}) is being processed since ${timeStr}.</p>`;
                    }).join('')}
                    <p class="mt-2 font-semibold">Verification may take up to 24 hours.</p>
                </div>
            </div>
        `;
        if (window.lucide) window.lucide.createIcons();
    } catch (e) {
        console.error("Load User Pending Topups Error:", e);
    }
}

async function loadNovels() {
    if (!db) return;
    const container = document.getElementById('novel-container-all');
    const homeUpdatesContainer = document.getElementById('home-latest-updates');
    
    if (container) container.innerHTML = '<p class="col-span-full text-center text-slate-400 py-10">Loading stories...</p>';
    if (homeUpdatesContainer) homeUpdatesContainer.innerHTML = ''; 

    try {
        const querySnapshot = await getDocs(collection(db, "novels"));
        let allNovels = [];
        querySnapshot.forEach((doc) => allNovels.push({ id: doc.id, ...doc.data() }));
        allNovels.sort((a, b) => {
            const timeA = a.lastChapterUpdatedAt?.toDate ? a.lastChapterUpdatedAt.toDate().getTime() : 0;
            const timeB = b.lastChapterUpdatedAt?.toDate ? b.lastChapterUpdatedAt.toDate().getTime() : 0;
            return timeB - timeA;
        });
        const timeAgoLimit = Date.now() - (30 * 24 * 60 * 60 * 1000); 

        if (container) container.innerHTML = '';
        allNovels.forEach(novel => {
            if (container) {
                const isNew = novel.createdAt && (novel.createdAt.toDate().getTime() > timeAgoLimit);
                const categoryDisplay = (novel.categories && novel.categories.length > 0) ? novel.categories[0] : 'Novel';
                
                const langFlag = novel.language === 'en' ? '🇺🇸 EN' : '🇹🇭 TH';
                const langBadgeColor = novel.language === 'en' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700';

                const card = document.createElement('div');
                card.className = "novel-card group cursor-pointer bg-white rounded-2xl shadow-sm hover:shadow-xl transition-all duration-300 border border-slate-100 overflow-hidden";
                card.onclick = () => window.showNovelDetail(novel.id, novel.status);
                card.innerHTML = `
                    <div class="relative h-64 overflow-hidden">
                        <img src="${novel.coverImageUrl || 'https://placehold.co/300x450'}" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" onerror="this.src='https://placehold.co/300x450?text=No+Image'">
                        ${isNew ? '<span class="absolute top-3 right-3 bg-gradient-to-r from-pink-500 to-purple-500 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-lg">NEW</span>' : ''}
                        ${novel.status === 'Coming Soon' ? '<span class="absolute top-3 left-3 bg-amber-500 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-lg">COMING SOON</span>' : ''}
                    </div>
                    <div class="p-4">
                        <div class="flex justify-between items-start mb-2">
                           <span class="text-[10px] font-bold text-sky-600 bg-sky-50 px-2 py-1 rounded-md uppercase tracking-wider truncate max-w-[100px]">${categoryDisplay}</span>
                           <span class="text-[10px] font-bold px-2 py-1 rounded-md ${langBadgeColor}">${langFlag}</span>
                        </div>
                         <h3 class="font-bold text-slate-800 text-lg leading-tight mb-1 truncate group-hover:text-sky-600 transition-colors">${novel.title_en}</h3>
                        <p class="text-xs text-slate-400 mb-3 truncate">by ${novel.author}</p>
                    </div>
                `;
                container.appendChild(card);
            }
            if (homeUpdatesContainer && homeUpdatesContainer.childElementCount < 5) {
                const item = document.createElement('div');
                item.className = "group relative bg-white rounded-xl shadow-sm hover:shadow-lg transition-all overflow-hidden cursor-pointer flex flex-col h-full border border-sky-50";
                item.onclick = () => window.showNovelDetail(novel.id, novel.status);
                item.innerHTML = `
                    <div class="relative h-40 overflow-hidden">
                        <img src="${novel.coverImageUrl}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" onerror="this.src='https://placehold.co/300x450?text=No+Image'">
                        <div class="absolute inset-0 bg-gradient-to-t from-slate-900/80 to-transparent"></div>
                          <div class="absolute bottom-3 left-3 right-3">
                             <h4 class="font-bold text-white text-sm truncate drop-shadow-md leading-tight">${novel.title_en}</h4>
                        </div>
                    </div>
                `;
                homeUpdatesContainer.appendChild(item);
            }
        });
        if (window.lucide) window.lucide.createIcons();
    } catch (error) { console.error("Error loading novels:", error); }
}

async function loadNovelsForDropdown(elementId) {
    const selectEl = document.getElementById(elementId);
    if (!db || !selectEl || !currentUser) return;
    selectEl.innerHTML = '<option value="">Loading...</option>';
    
    try {
        const q = query(collection(db, "novels"), where("authorId", "==", currentUser.uid));
        const querySnapshot = await getDocs(q);
        
        selectEl.innerHTML = `<option value="">Select Novel (${querySnapshot.size})</option>`;
        querySnapshot.forEach((doc) => {
            const novel = doc.data();
            const option = document.createElement('option');
            option.value = doc.id;
            option.textContent = `${novel.title_en} (${novel.language === 'en' ? 'EN' : 'TH'})`;
            selectEl.appendChild(option);
        });
        if (elementId === 'chapter-novel-select') {
             selectEl.onchange = (e) => {
                 const selectedNovelId = e.target.value;
                 if (selectedNovelId) {
                     window.loadNovelChaptersForAdmin(selectedNovelId);
                 } else {
                     const chapterListContainer = document.getElementById('admin-chapter-list');
                     if(chapterListContainer) chapterListContainer.innerHTML = '<p class="text-center text-slate-400 p-4">Select a novel to see chapters.</p>';
                 }
                 window.setAdminChapterMode('add', true);
            };
        }
    } catch (error) { console.error(error); }
}

window.showNovelDetail = async function(novelId, status) {
    window.showPage('page-novel-detail');
    window.scrollTo({top: 0});
    try {
        const docRef = doc(db, "novels", novelId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const novel = docSnap.data();
            document.getElementById('page-novel-detail').dataset.authorId = novel.authorId;
            document.getElementById('page-novel-detail').dataset.novelId = novelId;
            document.getElementById('page-novel-detail').dataset.novelTitle = novel.title_th || novel.title_en;
            
            document.getElementById('detail-cover-img').src = novel.coverImageUrl;
            document.getElementById('detail-title-en').textContent = novel.title_en;
            document.getElementById('detail-title-th').textContent = novel.title_th || '';
            document.getElementById('detail-author').textContent = novel.author;
            // Show Language
            const langText = novel.language === 'en' ? 'English (Translated)' : 'Thai (Original)';
            document.getElementById('detail-language').textContent = langText;
            
            document.getElementById('detail-status').textContent = novel.status;
            document.getElementById('detail-description').innerHTML = novel.description || 'No description.';
            const catContainer = document.getElementById('detail-categories');
            if(catContainer) {
                catContainer.innerHTML = '';
                if(novel.categories) {
                    novel.categories.forEach(c => {
                        const span = document.createElement('span');
                        span.className = "bg-sky-100 text-sky-700 text-xs px-2 py-1 rounded";
                        span.textContent = c;
                        catContainer.appendChild(span);
                    });
                }
            }
        }
        loadNovelChapters(novelId);
    } catch (e) { console.error(e); }
}

async function loadNovelChapters(novelId) {
    const list = document.getElementById('detail-chapter-list-container');
    if(list) list.innerHTML = '<div class="p-4 text-center">Loading...</div>';
    try {
        const q = query(collection(db, "chapters"), where("novelId", "==", novelId));
        const snap = await getDocs(q);
        
        if(list) list.innerHTML = '';
        
        if (snap.empty) { if(list) list.innerHTML = '<div class="p-4 text-center">ยังไม่มีตอนใหม่เร็วๆ นี้</div>'; return; }

        let chapters = [];
        snap.forEach(doc => chapters.push({id: doc.id, ...doc.data()}));
        chapters.sort((a,b) => a.chapterNumber - b.chapterNumber);

        const pageDetail = document.getElementById('page-novel-detail');
        const novelAuthorId = pageDetail.dataset.authorId;
        const isOwner = currentUser && (currentUser.uid === novelAuthorId || (currentUserData && currentUserData.role === 'admin'));
        const now = new Date();
        chapters.forEach(ch => {
            const publishDate = ch.publishedAt ? ch.publishedAt.toDate() : new Date(0);
            const isFuture = publishDate > now;
            
            if (isFuture && !isOwner) {
                const div = document.createElement('div');
                div.className = "p-4 border-b border-slate-50 flex justify-between items-center opacity-60";
                div.innerHTML = `<div class="flex items-center"><span class="bg-slate-100 text-slate-500 text-xs px-2 py-1 rounded mr-3">#${ch.chapterNumber}</span><span class="font-medium text-slate-500">Coming Soon...</span></div>`;
                if(list) list.appendChild(div);
                return; 
            }
            const isFree = !ch.pointCost || ch.pointCost == 0;
            const div = document.createElement('div');
            div.className = "p-4 hover:bg-slate-50 cursor-pointer flex justify-between items-center border-b border-slate-50 last:border-0 transition";
            const scheduleBadge = isFuture ? `<span class="ml-2 text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded">Scheduled</span>` : '';
            div.innerHTML = `
                <div class="flex items-center">
                   <span class="bg-slate-100 text-slate-500 text-xs px-2 py-1 rounded mr-3">#${ch.chapterNumber}</span>
                   <span class="font-medium text-slate-700">${ch.title} ${scheduleBadge}</span>
                </div>
                 <div class="flex items-center">
                    ${isFree ? '<span class="text-xs bg-green-100 text-green-600 px-2 py-1 rounded-full font-bold">Free</span>' : `<span class="text-xs bg-sky-100 text-sky-600 px-2 py-1 rounded-full font-bold flex items-center gap-1"><i data-lucide="lock" class="w-3 h-3"></i> ${ch.pointCost} P</span>`}
                </div>
            `;
            // ส่ง novelAuthorId เข้าไปด้วย เพื่อเช็คความเป็นเจ้าของ
            div.onclick = () => window.checkAndReadChapter(ch.id, ch.pointCost, ch.novelId, ch.chapterNumber, novelAuthorId);
            if(list) list.appendChild(div);
        });
        if (window.lucide) window.lucide.createIcons();
    } catch(e) { console.error(e); }
}

window.loadNovelChaptersForAdmin = async function(novelId) {
    const list = document.getElementById('admin-chapter-list');
    if(!list) return;
    list.innerHTML = '<p class="text-center text-slate-400 p-4">Loading chapters...</p>';

    try {
        const q = query(collection(db, "chapters"), where("novelId", "==", novelId));
        const snap = await getDocs(q);
        
        list.innerHTML = '';

        if (snap.empty) { list.innerHTML = '<p class="text-center text-slate-400 p-4">No chapters found.</p>'; return; }

        let chapters = [];
        snap.forEach(doc => chapters.push({ id: doc.id, ...doc.data() }));
        chapters.sort((a, b) => b.chapterNumber - a.chapterNumber);
        chapters.forEach(ch => {
            const chId = ch.id;
            const isFree = !ch.pointCost || ch.pointCost == 0;
            const publishDate = ch.publishedAt ? ch.publishedAt.toDate() : new Date(0);
            const isFuture = publishDate > new Date();

            const div = document.createElement('div');
            div.className = "p-3 border-b border-slate-100 flex justify-between items-center hover:bg-slate-50 transition";
            
            const scheduleBadge = isFuture ?
                `<span class="ml-2 text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded">Scheduled: ${new Date(ch.publishedAt.toDate()).toLocaleString()}</span>` : '';
            
            div.innerHTML = `
                  <div class="flex-1 min-w-0">
                    <span class="text-xs font-bold text-indigo-600 mr-2">#${ch.chapterNumber}</span>
                    <span class="font-medium text-slate-700 truncate">${ch.title} ${scheduleBadge}</span>
                    ${isFree ? `<span class="ml-2 text-[10px] bg-green-100 text-green-600 px-2 py-0.5 rounded-full font-bold">Free</span>` : 
                        `<span class="ml-2 text-[10px] bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full font-bold">${ch.pointCost} P</span>`}
                </div>
                <div class="flex space-x-2">
                   <button onclick="window.loadChapterToEdit('${chId}')" class="text-indigo-500 hover:text-indigo-700 text-sm font-medium">Edit</button>
                    <button onclick="window.deleteChapter('${chId}', '${novelId}')" class="text-red-500 hover:text-red-700 text-sm font-medium">Delete</button>
                </div>
            `;
            list.appendChild(div);
        });

    } catch(e) { console.error("Error loading admin chapters:", e); list.innerHTML = '<p class="text-center text-red-500 p-4">Error loading chapters.</p>'; }
    if (window.lucide) window.lucide.createIcons();
}

// ⭐ UPDATED REVENUE LOGIC: Check Language & Rate
window.checkAndReadChapter = async function(chapterId, cost, novelId, chapterNumber, authorId) {
    if (!cost || cost <= 0) { 
        window.showReaderPage(chapterId, novelId, chapterNumber);
        return;
    }
    
    // Author/Admin bypass
    if (currentUser && (currentUser.uid === authorId || (currentUserData && currentUserData.role === 'admin'))) {
        window.showReaderPage(chapterId, novelId, chapterNumber);
        return;
    }

    if (!currentUser) { Swal.fire('Login Required', 'Please login to unlock chapters.', 'warning'); return; }
    if (currentUserData.unlockedChapters && currentUserData.unlockedChapters.includes(chapterId)) { window.showReaderPage(chapterId, novelId, chapterNumber); return; }
    if ((currentUserData.balancePoints || 0) < cost) { Swal.fire('Insufficient Points', 'Please top up.', 'error'); return; }

    Swal.fire({
        title: `Unlock for ${cost} Points?`, icon: 'question', showCancelButton: true, confirmButtonText: 'Unlock'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                // 1. Get Novel Data to check Language
                const novelSnap = await getDoc(doc(db, "novels", novelId));
                let shareRate = SHARE_RATE_TH; // Default 70%
                let walletField = 'walletBalance_TH';
                let grossField = 'grossSales_TH';

                if (novelSnap.exists()) {
                    const novelData = novelSnap.data();
                    if (novelData.language === 'en') {
                        shareRate = SHARE_RATE_EN; // 80%
                        walletField = 'walletBalance_EN';
                        grossField = 'grossSales_EN';
                    }
                }

                // 2. Calculate
                const thbGross = (cost / 100) * EXCHANGE_RATE_USD_THB; // Total Sale in THB
                const thbNetWriter = thbGross * shareRate; // Writer's Share

                // 3. Update Reader (Deduct Points)
                await updateDoc(doc(db, "users", currentUser.uid), {
                    balancePoints: increment(-cost), 
                    unlockedChapters: arrayUnion(chapterId)
                });
                
                // 4. Update Writer (Add Money to Specific Wallet & Track Gross)
                await updateDoc(doc(db, "users", authorId), { 
                    [walletField]: increment(thbNetWriter),
                    [grossField]: increment(thbGross)
                });
                // 5. Update old 'walletBalance' for Dashboard compatibility
                await updateDoc(doc(db, "users", authorId), { 
                    walletBalance: increment(thbNetWriter),
                });
                // Local update
                currentUserData.balancePoints -= cost;
                if(!currentUserData.unlockedChapters) currentUserData.unlockedChapters = [];
                currentUserData.unlockedChapters.push(chapterId);
                
                Swal.fire('Unlocked!', 'Enjoy reading.', 'success');
                window.showReaderPage(chapterId, novelId, chapterNumber);
            } catch (err) { Swal.fire('Error', err.message, 'error'); }
        }
    });
}

window.showReaderPage = async function(chapterId, novelId, chapterNumber) {
    window.showPage('page-reader');
    window.scrollTo({top: 0});
    const contentDiv = document.getElementById('reader-content-div');
    const titleSpan = document.getElementById('reader-title');
    const commentSection = document.getElementById('reader-comment-section');

    // 1. กำหนดข้อมูลปัจจุบันให้ element
    document.getElementById('page-reader').dataset.novelId = novelId;
    document.getElementById('page-reader').dataset.currentChapterId = chapterId;
    document.getElementById('page-reader').dataset.currentChapterNumber = chapterNumber;

    // 2. โหลดเนื้อหาตอน
    if(contentDiv) contentDiv.innerHTML = '<p class="text-center text-slate-400 py-10">Loading...</p>';
    try {
        const snap = await getDoc(doc(db, "chapters", chapterId));
        if(snap.exists()) {
            const ch = snap.data();
            // บันทึก Author ID ลงใน dataset
            if (ch.authorId) {
                document.getElementById('page-reader').dataset.authorId = ch.authorId;
            }

            document.getElementById('reader-chapter-title').textContent = ch.title;
            if(titleSpan) titleSpan.textContent = ch.title;
            let contentHtml = ch.content;
            if(!contentHtml.includes('<p>')) {
                contentHtml = ch.content.split('\n').map(para => para.trim() ? `<p>${para}</p>` : '').join('');
            }
            if(contentDiv) contentDiv.innerHTML = contentHtml;
            // ⭐ Load Comments V2
            window.loadComments(chapterId);
            window.setupCommentForm(chapterId, novelId, chapterNumber, ch.title, ch.authorId);
        }

        // 3. โหลดและเก็บรายการตอนทั้งหมด
        await loadAndStoreNovelChapters(novelId);
        // 4. ตั้งค่าปุ่มนำทาง
        setupReaderNavigation();

    } catch(e) { console.error(e); }
}

// ⭐ V2: Setup Comment Form with User Data
window.setupCommentForm = function(chapterId, novelId, chapterNumber, chapterTitle, writerId) {
    const formContainer = document.getElementById('comment-form-container');
    if (currentUser) {
        formContainer.innerHTML = `
            <div class="flex gap-4">
                <div class="flex-shrink-0 w-10 h-10 rounded-full bg-sky-100 flex items-center justify-center text-sky-600 font-bold">
                    ${currentUserData.username ? currentUserData.username.charAt(0).toUpperCase() : 'U'}
                </div>
                <div class="flex-1">
                    <div class="relative">
                        <textarea id="comment-input" class="w-full p-4 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-500 outline-none text-sm text-slate-700 bg-slate-50 focus:bg-white transition-all" placeholder="Leave a comment... (to encourage the author)"></textarea>
                    </div>
                    <div class="mt-3 text-right">
                        <button onclick="window.postComment('${chapterId}', '${novelId}', '${chapterNumber}', '${chapterTitle.replace(/'/g, "\\'")}', '${writerId}')" class="bg-sky-600 hover:bg-sky-700 text-white px-6 py-2 rounded-full font-bold text-sm shadow-md transition-all transform hover:scale-105">
                            Post Comment
                        </button>
                    </div>
                </div>
            </div>
        `;
    } else {
        formContainer.innerHTML = `
            <div class="text-center p-6 bg-slate-50 rounded-xl border border-slate-100">
                <p class="text-slate-500 mb-3">กรุณาเข้าสู่ระบบเพื่อแสดงความคิดเห็น</p>
                <button onclick="window.showPage('page-login')" class="text-sky-600 font-bold hover:underline">Login Now</button>
            </div>
        `;
    }
}

// ⭐ V2: Post Main Comment
window.postComment = async function(chapterId, novelId, chapterNumber, chapterTitle, writerId) {
    const input = document.getElementById('comment-input');
    const message = input.value.trim();
    if (!message) return;

    if (message.length > 500) { Swal.fire('ยาวเกินไป', 'กรุณาพิมพ์ไม่เกิน 500 ตัวอักษร', 'warning'); return; }

    try {
        // 1. บันทึก Comments
        await addDoc(collection(db, "comments"), {
            chapterId: chapterId,
            userId: currentUser.uid,
            username: currentUserData.username,
            message: message,
            timestamp: serverTimestamp(),
            likes: [], 
            parentId: null 
        });
        // 2. แจ้งเตือนนักเขียน
        if (writerId && writerId !== currentUser.uid) {
            const novelTitle = document.getElementById('page-reader').dataset.novelTitle || "นิยายของคุณ";
            await addDoc(collection(db, "notifications"), {
                recipientId: writerId,
                senderId: currentUser.uid,
                senderName: currentUserData.username,
                type: 'comment',
                novelTitle: novelTitle,
                chapterNumber: chapterNumber,
                chapterTitle: chapterTitle,
                message: message,
                read: false,
                timestamp: serverTimestamp()
            });
        }

        input.value = '';
        window.loadComments(chapterId);
        
        Swal.fire({
            icon: 'success',
            title: 'โพสต์เรียบร้อย!',
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 1500
        });
        
    } catch (error) {
        console.error("Post error:", error);
        Swal.fire('Error', 'ส่งคอมเมนต์ไม่สำเร็จ', 'error');
    }
}

// ⭐ V2: Load Comments with Replies
window.loadComments = async function(chapterId) {
    const container = document.getElementById('comment-list-container');
    if(!container) return;
    
    container.innerHTML = '<p class="text-center text-slate-400">Loading discussion...</p>';

    try {
        const q = query(collection(db, "comments"), where("chapterId", "==", chapterId), orderBy("timestamp", "asc"));
        const snap = await getDocs(q);
        container.innerHTML = '';
        if (snap.empty) {
            container.innerHTML = '<p class="text-center text-slate-400">There are no comments yet. Be the first!</p>';
            return;
        }

        const allComments = [];
        snap.forEach(doc => allComments.push({ id: doc.id, ...doc.data() }));
        
        const mainComments = allComments.filter(c => !c.parentId);
        const replies = allComments.filter(c => c.parentId);

        mainComments.sort((a,b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
        mainComments.forEach(main => {
            const myReplies = replies.filter(r => r.parentId === main.id);
            myReplies.sort((a,b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));

            const mainHtml = window.createCommentHTML(main, false);
            const div = document.createElement('div');
            div.className = "comment-box p-4 border-b border-slate-100";
            div.innerHTML = mainHtml;

            if (myReplies.length > 0) {
                const replyContainer = document.createElement('div');
                replyContainer.className = "reply-container";
                myReplies.forEach(rep => {
                    const repDiv = document.createElement('div');
                    repDiv.className = "mt-4 pt-4 border-t border-slate-100/50";
                    repDiv.innerHTML = window.createCommentHTML(rep, true);
                    replyContainer.appendChild(repDiv);
                });
                div.appendChild(replyContainer);
            }

            const replyFormDiv = document.createElement('div');
            replyFormDiv.id = `reply-box-${main.id}`;
            replyFormDiv.className = "reply-input-box hidden ml-12";
            replyFormDiv.innerHTML = `
                <textarea id="reply-input-${main.id}" placeholder="ตอบกลับคุณ ${main.username}..."></textarea>
                <div class="flex justify-end gap-2 mt-2">
                    <button onclick="document.getElementById('reply-box-${main.id}').classList.add('hidden')" class="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                    <button onclick="window.submitReply('${main.id}', '${main.userId}')" class="btn-sm-primary">Reply</button>
                </div>
            `;
            div.appendChild(replyFormDiv);

            container.appendChild(div);
        });

        if(window.lucide) window.lucide.createIcons();

    } catch (error) { console.error("Load comments error:", error); }
}

// ⭐ V2: Helper สร้าง HTML ของคอมเมนต์
window.createCommentHTML = function(c, isReply) {
    const timeAgo = c.timestamp ? new Date(c.timestamp.toDate()).toLocaleString('th-TH') : 'Just now';
    const pageEl = document.getElementById('page-reader');
    const authorId = pageEl.dataset.authorId;
    const isAdminOrAuthor = (c.userId === authorId) ? '<span class="admin-badge">Writer</span>' : '';
    
    const myUid = currentUser ? currentUser.uid : null;
    const likes = c.likes || [];
    const isLiked = likes.includes(myUid);
    const likeCount = likes.length;
    const heartClass = isLiked ? 'liked' : '';
    const heartIcon = 'heart';

    const replyBtn = isReply ? '' : `
        <button onclick="window.toggleReplyBox('${c.id}')" class="action-btn hover:text-sky-600">
            <i data-lucide="message-square" class="w-4 h-4"></i> Reply
        </button>
    `;
    let deleteBtn = '';
    if (myUid && (c.userId === myUid || (currentUserData && currentUserData.role === 'admin'))) {
        deleteBtn = `
            <button onclick="window.deleteComment('${c.id}')" class="action-btn hover:text-red-500 ml-auto">
                <i data-lucide="trash" class="w-4 h-4"></i>
            </button>
        `;
    }

    return `
        <div class="flex gap-4">
            <div class="flex-shrink-0 w-8 h-8 md:w-10 md:h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 font-bold text-xs md:text-sm">
                ${c.username.charAt(0).toUpperCase()}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-baseline mb-1">
                    <h4 class="font-bold text-slate-700 text-sm">${c.username} ${isAdminOrAuthor}</h4>
                    <span class="text-[10px] text-slate-400">${timeAgo}</span>
                </div>
                <p class="text-slate-600 text-sm leading-relaxed whitespace-pre-line">${c.message}</p>
                <div class="comment-actions">
                    <button onclick="window.toggleLike('${c.id}')" class="action-btn ${heartClass}">
                        <i data-lucide="${heartIcon}" class="w-4 h-4"></i> 
                        <span id="like-count-${c.id}">${likeCount > 0 ? likeCount : 'Like'}</span>
                    </button>
                    ${replyBtn}
                    ${deleteBtn}
                </div>
            </div>
        </div>
    `;
}

// ⭐ V2: Toggle Like Logic
window.toggleLike = async function(commentId) {
    if (!currentUser) { Swal.fire('Login Required', 'กรุณาล็อกอินเพื่อกดถูกใจ', 'warning'); return; }

    const commentRef = doc(db, "comments", commentId);
    try {
        const docSnap = await getDoc(commentRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            const likes = data.likes || [];
            const uid = currentUser.uid;
            if (likes.includes(uid)) {
                await updateDoc(commentRef, { likes: likes.filter(id => id !== uid) });
            } else {
                await updateDoc(commentRef, { likes: arrayUnion(uid) });
            }
            window.loadComments(document.getElementById('page-reader').dataset.currentChapterId);
        }
    } catch (e) { console.error("Like error:", e); }
}

// ⭐ V2: เปิด/ปิด กล่อง Reply
window.toggleReplyBox = function(commentId) {
    if (!currentUser) { Swal.fire('Login Required', 'กรุณาล็อกอินเพื่อตอบกลับ', 'warning'); return; }
    const box = document.getElementById(`reply-box-${commentId}`);
    if (box) {
        box.classList.toggle('hidden');
        if (!box.classList.contains('hidden')) {
            setTimeout(() => document.getElementById(`reply-input-${commentId}`).focus(), 100);
        }
    }
}

// ⭐ V2: ส่ง Reply
window.submitReply = async function(parentId, parentUserId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    const message = input.value.trim();
    if (!message) return;

    const pageEl = document.getElementById('page-reader');
    const chapterId = pageEl.dataset.currentChapterId;
    const chapterNumber = pageEl.dataset.currentChapterNumber;
    const novelTitle = pageEl.dataset.novelTitle || "นิยาย";

    try {
        await addDoc(collection(db, "comments"), {
            chapterId: chapterId,
            parentId: parentId,
            userId: currentUser.uid,
            username: currentUserData.username,
            message: message,
            timestamp: serverTimestamp(),
            likes: []
        });
        if (parentUserId && parentUserId !== currentUser.uid) {
             await addDoc(collection(db, "notifications"), {
                recipientId: parentUserId,
                senderId: currentUser.uid,
                senderName: currentUserData.username,
                type: 'reply',
                novelTitle: novelTitle,
                chapterNumber: chapterNumber,
                message: `ตอบกลับ: "${message}"`,
                read: false,
                timestamp: serverTimestamp()
            });
        }
        input.value = '';
        window.loadComments(chapterId);
    } catch (error) { console.error("Reply error:", error); }
}

// ⭐ V2: ลบคอมเมนต์
window.deleteComment = function(commentId) {
    Swal.fire({
        title: 'ลบความคิดเห็น?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'ลบ',
        confirmButtonColor: '#ef4444'
    }).then(async (res) => {
        if (res.isConfirmed) {
            await deleteDoc(doc(db, "comments", commentId));
            window.loadComments(document.getElementById('page-reader').dataset.currentChapterId);
        }
    });
}

// ⭐ NEW: Load Notifications
window.loadNotifications = async function() {
    const container = document.getElementById('notification-list-container');
    if (!container || !currentUser) return;

    container.innerHTML = '<div class="text-center py-10"><i data-lucide="loader-2" class="w-8 h-8 animate-spin mx-auto text-sky-500"></i></div>';
    if(window.lucide) window.lucide.createIcons();
    try {
        const q = query(collection(db, "notifications"), where("recipientId", "==", currentUser.uid), orderBy("timestamp", "desc"));
        const snap = await getDocs(q);
        
        container.innerHTML = '';

        if (snap.empty) {
            container.innerHTML = `
                <div class="text-center text-slate-400 py-8">
                    <i data-lucide="bell-off" class="w-10 h-10 mx-auto mb-2 opacity-50"></i>
                    <p>ไม่มีการแจ้งเตือนใหม่</p>
                </div>`;
            if(window.lucide) window.lucide.createIcons();
            return;
        }

        const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let deleteCount = 0;

        snap.forEach(docSnap => {
            const notif = docSnap.data();
            const notifTime = notif.timestamp ? notif.timestamp.toDate().getTime() : 0;

            if (now - notifTime > FIVE_DAYS_MS) {
                deleteDoc(doc(db, "notifications", docSnap.id)); 
                deleteCount++;
                return;
            }

            const timeStr = notif.timestamp ? new Date(notif.timestamp.toDate()).toLocaleString('th-TH') : '';
            const unreadClass = notif.read ? '' : 'unread'; 
            
            let icon, title, messageHtml;

            // ⭐ UPDATED: Handle new Topup notification types
            if (notif.type === 'point_success') {
                icon = 'check-circle';
                title = 'Point Top-up Success!';
                messageHtml = `<div class="mt-2 bg-green-50 p-2 rounded-lg text-sm text-green-700 italic border-l-2 border-green-300">
                    "${notif.message}"
                </div>`;
            } else if (notif.type === 'point_reject') {
                icon = 'alert-triangle';
                title = 'Point Purchase Rejected';
                messageHtml = `<div class="mt-2 bg-red-50 p-2 rounded-lg text-sm text-red-700 italic border-l-2 border-red-300">
                    "${notif.message}"
                </div>`;
            } else if (notif.type === 'reply') {
                icon = 'corner-down-left';
                title = `นักเขียนตอบกลับ: ${notif.senderName}`;
                messageHtml = `<div class="mt-2 bg-slate-50 p-2 rounded-lg text-sm text-slate-600 italic border-l-2 border-slate-200">
                    "${notif.message}"
                </div>`;
            } else { // Comment notification type
                icon = 'message-circle';
                title = `ความคิดเห็นใหม่จาก ${notif.senderName}`;
                 messageHtml = `<div class="mt-2 bg-slate-50 p-2 rounded-lg text-sm text-slate-600 italic border-l-2 border-slate-200">
                    "${notif.message}"
                </div>`;
            }


            const div = document.createElement('div');
            div.className = `notification-item bg-white p-4 rounded-xl border border-slate-100 shadow-sm flex gap-4 ${unreadClass}`;
            div.innerHTML = `
                <div class="flex-shrink-0 mt-1">
                    <div class="w-10 h-10 rounded-full bg-sky-100 text-sky-600 flex items-center justify-center">
                        <i data-lucide="${icon}" class="w-5 h-5"></i>
                    </div>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-start">
                        <div>
                            <p class="text-sm font-bold text-slate-800">${title}</p>
                            ${notif.type !== 'point_success' && notif.type !== 'point_reject' ? 
                                `<p class="text-xs text-slate-500 mt-0.5">เรื่อง: <span class="text-sky-600">${notif.novelTitle || 'นิยาย'}</span> (ตอนที่ ${notif.chapterNumber})</p>` :
                                `<p class="text-xs text-slate-500 mt-0.5">${notif.novelTitle}</p>`
                            }
                        </div>
                        <button onclick="window.deleteNotification('${docSnap.id}')" class="delete-notif-btn text-slate-400 p-1 rounded-full" title="ลบการแจ้งเตือน">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                    ${messageHtml}
                    <p class="text-[10px] text-slate-400 mt-2 text-right">${timeStr}</p>
                </div>
            `;
            div.onmouseenter = () => {
                if (!notif.read) {
                    updateDoc(doc(db, "notifications", docSnap.id), { read: true });
                    div.classList.remove('unread');
                    window.updateNotificationBadge(); 
                }
            };
            container.appendChild(div);
        });

        if (deleteCount > 0) console.log(`Auto-deleted ${deleteCount} old notifications.`);
        if (window.lucide) window.lucide.createIcons();
    } catch (error) { console.error("Load notifications error:", error); }
}

window.deleteNotification = async function(notifId) {
    try {
        await deleteDoc(doc(db, "notifications", notifId));
        window.loadNotifications(); 
        window.updateNotificationBadge();
    } catch (error) { console.error("Delete error:", error); }
}

window.updateNotificationBadge = async function() {
    if (!currentUser) return;
    const badge = document.getElementById('admin-notify-badge');
    const btn = document.getElementById('admin-notify-btn');
    if (!badge || !btn) return;

    try {
        const q = query(collection(db, "notifications"), where("recipientId", "==", currentUser.uid), where("read", "==", false));
        const snap = await getDocs(q);
        const count = snap.size;

        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.classList.remove('hidden');
            btn.classList.add('text-sky-600'); 
        } else {
            badge.classList.add('hidden');
            btn.classList.remove('text-sky-600');
        }
    } catch (e) { console.error("Badge update error:", e); }
}

async function loadAndStoreNovelChapters(novelId) {
    if (currentNovelChapters.length === 0 || currentNovelChapters[0]?.novelId !== novelId) {
        console.log(`Loading all chapters for novel ${novelId}`);
        const q = query(collection(db, "chapters"), where("novelId", "==", novelId));
        const snap = await getDocs(q);
        
        currentNovelChapters = [];
        snap.forEach(doc => {
            currentNovelChapters.push({ id: doc.id, ...doc.data() });
        });
        currentNovelChapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        console.log("Chapters loaded and sorted:", currentNovelChapters);
    }
}

function setupReaderNavigation() {
    const pageEl = document.getElementById('page-reader');
    const currentNumber = parseInt(pageEl.dataset.currentChapterNumber);
    const novelId = pageEl.dataset.novelId;
    const authorId = pageEl.dataset.authorId;
    const prevBtn = document.getElementById('reader-prev-btn');
    const nextBtn = document.getElementById('reader-next-btn');
    const removeClasses = ['bg-sky-600', 'bg-slate-300', 'bg-slate-100', 'bg-sky-100', 'text-white', 'text-slate-600', 'text-sky-700'];
    prevBtn.classList.remove(...removeClasses);
    prevBtn.classList.add('px-4', 'py-2', 'rounded-lg', 'font-medium', 'text-sm', 'transition');
    nextBtn.classList.remove(...removeClasses);
    nextBtn.classList.add('px-4', 'py-2', 'rounded-lg', 'font-medium', 'text-sm', 'shadow-lg', 'shadow-sky-200', 'transition'); 

    const currentIndex = currentNovelChapters.findIndex(ch => ch.chapterNumber === currentNumber);
    prevBtn.onclick = null;
    nextBtn.onclick = null;
    if (currentIndex < currentNovelChapters.length - 1) {
        const nextChapter = currentNovelChapters[currentIndex + 1];
        nextBtn.disabled = false;
        nextBtn.classList.add('bg-sky-600', 'text-white', 'hover:bg-sky-700');
        nextBtn.onclick = () => window.checkAndReadChapter(
            nextChapter.id, 
            nextChapter.pointCost, 
            novelId, 
            nextChapter.chapterNumber,
            authorId
        );
    } else {
        nextBtn.disabled = true;
        nextBtn.classList.add('bg-slate-300', 'text-slate-600');
    }

    if (currentIndex > 0) {
        const prevChapter = currentNovelChapters[currentIndex - 1];
        prevBtn.disabled = false;
        prevBtn.classList.add('bg-sky-100', 'text-sky-700', 'hover:bg-sky-200');
        prevBtn.onclick = () => window.checkAndReadChapter(
            prevChapter.id, 
            prevChapter.pointCost, 
            novelId, 
            prevChapter.chapterNumber,
            authorId
        );
    } else {
        prevBtn.disabled = true;
        prevBtn.classList.add('bg-slate-300', 'text-slate-600');
    }
}

window.selectCoffee = function(amount) {
    document.querySelectorAll('.coffee-card').forEach(c => c.classList.remove('selected'));
    document.getElementById(`cup-${amount}`).classList.add('selected');
    document.getElementById('donate-section').classList.remove('hidden');
    document.getElementById('donate-amount-val').value = amount;
}

// ============================================================
//  4. WRITER SYSTEM
// ============================================================
window.setAdminNovelMode = function(mode) {
    const form = document.getElementById('add-novel-form');
    const editor = document.getElementById('novel-description-editor');
    const btnSave = document.getElementById('btn-save-novel');

    if (mode === 'add') {
        if(form) form.reset();
        if(editor) editor.innerHTML = ''; 
        currentEditingNovelId = null; 
        if(btnSave) btnSave.textContent = 'บันทึกนิยาย (Save)';
    } 
    else { 
        if(btnSave) btnSave.textContent = 'อัปเดตนิยาย (Update)';
    }
}

window.setAdminChapterMode = function(mode, keepNovelSelect = false) {
    const form = document.getElementById('add-chapter-form');
    let currentNovelVal = '';
    const novelSelect = document.getElementById('chapter-novel-select');
    if(keepNovelSelect && novelSelect) {
        currentNovelVal = novelSelect.value;
    }

    if(form) form.reset(); 

    if(keepNovelSelect && novelSelect) {
        novelSelect.value = currentNovelVal;
    }

    const editor = document.getElementById('chapter-content-editor');
    currentEditingChapterId = null; 
    const btnSave = document.getElementById('btn-save-chapter'); 

    if(editor) editor.innerHTML = '';
    if(btnSave) btnSave.textContent = (mode === 'add') ? 'บันทึกและเผยแพร่ (Save Chapter)' : 'อัปเดตตอน (Update Chapter)';
}

window.loadNovelToEdit = async function(novelId) {
    window.showPage('page-admin-add-novel');
    currentEditingNovelId = novelId; 
    window.setAdminNovelMode('edit');
    try {
        const docRef = doc(db, "novels", novelId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            document.getElementById('novel-title-en').value = data.title_en;
            document.getElementById('novel-title-th').value = data.title_th;
            document.getElementById('novel-author').value = data.author;
            document.getElementById('novel-cover-url').value = data.coverImageUrl;
            document.getElementById('novel-status').value = data.status;
            document.getElementById('novel-category').value = (data.categories && data.categories.length > 0) ? data.categories[0] : '';
            document.getElementById('novel-description-editor').innerHTML = data.description;
            document.getElementById('novel-title-original').value = data.title_original || '';
            const langSelect = document.getElementById('novel-language');
            if (langSelect) langSelect.value = data.language || 'th';
        }
    } catch(e) { console.error(e); }
}

window.deleteNovel = function(novelId) {
    Swal.fire({
        title: 'ยืนยันการลบนิยาย?',
        text: 'การลบจะรวมถึง **ทุกตอน** ที่เกี่ยวข้องและไม่สามารถกู้คืนได้!',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'ใช่, ลบเลย!',
        cancelButtonText: 'ยกเลิก',
        reverseButtons: true,
        confirmButtonColor: '#dc2626'
    }).then(async (result) => {
         if (result.isConfirmed) {
            try {
                const q = query(collection(db, "chapters"), where("novelId", "==", novelId));
                const chapSnap = await getDocs(q);
                const deleteChapterPromises = chapSnap.docs.map(d => deleteDoc(doc(db, "chapters", d.id)));
                await Promise.all(deleteChapterPromises);
                await deleteDoc(doc(db, "novels", novelId));
                
                Swal.fire('ลบเรียบร้อย!', 'นิยายและทุกตอนถูกลบแล้ว', 'success');
                window.loadWriterDashboard();
                loadNovels(); 
            } catch (error) {
                console.error("Error deleting novel:", error);
                Swal.fire('Error', 'ไม่สามารถลบนิยายได้: ' + error.message, 'error');
            }
        }
    });
}

window.loadChapterToEdit = async function(chapterId) {
    window.setAdminChapterMode('edit', true);
    currentEditingChapterId = chapterId;
    try {
        const docSnap = await getDoc(doc(db, "chapters", chapterId));
        if (docSnap.exists()) {
            const data = docSnap.data();
            const novelSelect = document.getElementById('chapter-novel-select');
            novelSelect.value = data.novelId; 

            document.getElementById('chapter-number').value = data.chapterNumber;
            document.getElementById('chapter-title').value = data.title;
            document.getElementById('chapter-point-type').value = data.pointCost?.toString() || '0';
            document.getElementById('chapter-content-editor').innerHTML = data.content;
            if (data.publishedAt && data.publishedAt.toDate) {
                const date = data.publishedAt.toDate();
                const formattedDate = date.getFullYear() + '-' + 
                                      ('0' + (date.getMonth() + 1)).slice(-2) + '-' + 
                                      ('0' + date.getDate()).slice(-2) + 'T' + 
                                      ('0' + date.getHours()).slice(-2) + ':' + 
                                      ('0' + date.getMinutes()).slice(-2);
                document.getElementById('chapter-schedule').value = formattedDate;
            } else {
                 document.getElementById('chapter-schedule').value = '';
            }
            window.loadNovelChaptersForAdmin(data.novelId);
        } else {
            Swal.fire('Error', 'ไม่พบข้อมูลตอนนี้', 'error');
        }
    } catch(e) { 
        console.error(e); 
        Swal.fire('Error', 'เกิดข้อผิดพลาดในการโหลดข้อมูลตอน', 'error');
    }
}

window.deleteChapter = function(chapterId, novelId) {
    Swal.fire({
        title: 'ยืนยันการลบตอนนี้?',
        text: 'ตอนนี้จะถูกลบออกและไม่สามารถกู้คืนได้',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'ใช่, ลบตอน!',
        cancelButtonText: 'ยกเลิก',
        reverseButtons: true,
        confirmButtonColor: '#dc2626'
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                await deleteDoc(doc(db, "chapters", chapterId));
                Swal.fire('ลบเรียบร้อย!', 'ตอนนี้ถูกลบแล้ว', 'success');
                window.loadNovelChaptersForAdmin(novelId);
            } catch (error) {
                console.error("Error deleting chapter:", error);
                  Swal.fire('Error', 'ไม่สามารถลบตอนได้: ' + error.message, 'error');
            }
        }
    });
}


window.loadWriterDashboard = async function() {
    console.log("Loading Dashboard...");
    if(!document.getElementById('writer-dash-name')) {
        console.warn("Dashboard elements not found. Stopping.");
        return;
    }

    if (!currentUser) {
        Swal.fire('Restricted', 'For Writers Only', 'error');
        return;
    }
    
    const role = (currentUserData.role || '').toLowerCase();
    if (role !== 'writer' && role !== 'admin') {
        Swal.fire('Restricted', 'Access Denied', 'error');
        window.showPage('page-home'); 
        return;
    }
    
    const nameEl = document.getElementById('writer-dash-name');
    if(nameEl) nameEl.textContent = currentUserData.username;
    const balanceEl = document.getElementById('writer-wallet-balance');
    
    // SUM all wallets for Dashboard Display
    const thbWallet = (currentUserData.walletBalance || 0) + 
                      (currentUserData.walletBalance_TH || 0) + 
                      (currentUserData.walletBalance_EN || 0);
    if(balanceEl) {
        balanceEl.textContent = `฿${thbWallet.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }
    
    const q = query(collection(db, "novels"), where("authorId", "==", currentUser.uid));
    const querySnapshot = await getDocs(q);
    const container = document.getElementById('writer-novel-list');
    
    const statEl = document.getElementById('stat-total-novels');
    if(statEl) statEl.textContent = querySnapshot.size;

    if(!container) return;
    container.innerHTML = '';
    
    if (querySnapshot.empty) {
        container.innerHTML = `<p class="p-4 text-center col-span-full text-slate-400">ยังไม่มีนิยาย</p>`;
        return;
    }

    querySnapshot.forEach((doc) => {
        const novel = doc.data();
        const langBadge = novel.language === 'en' ? '<span class="text-[10px] bg-blue-100 text-blue-700 px-1 rounded">EN</span>' : '<span class="text-[10px] bg-red-100 text-red-700 px-1 rounded">TH</span>';
        
        const card = document.createElement('div');
        card.className = "bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex gap-4 hover:shadow-md transition";
        card.innerHTML = `
             <img src="${novel.coverImageUrl}" class="w-20 h-28 object-cover rounded-md bg-slate-200" onerror="this.src='https://placehold.co/100x150?text=No+Image'">
            <div class="flex-1 min-w-0">
               <h4 class="font-bold text-slate-800 truncate">${novel.title_th || novel.title_en} ${langBadge}</h4>
                <p class="text-xs text-slate-400 mb-2">สถานะ: ${novel.status}</p>
                <div class="flex flex-wrap gap-2 mt-2">
                     <button onclick="window.loadNovelToEdit('${doc.id}')" class="px-3 py-1 bg-amber-100 text-amber-700 rounded-md text-xs font-bold hover:bg-amber-200">Edit</button>
                   <button class="px-3 py-1 bg-sky-100 text-sky-700 rounded-md text-xs font-bold hover:bg-sky-200" onclick="window.showPage('page-admin-add-chapter')">Add Chapter</button>
                    <button onclick="window.deleteNovel('${doc.id}')" class="px-3 py-1 bg-red-100 text-red-700 rounded-md text-xs font-bold hover:bg-red-200">Delete</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
    if (window.lucide) window.lucide.createIcons();
}

window.loadWriterWithdraw = function() {
    if (!currentUserData) return;
    // 1. Fetch Wallets (Legacy + New)
    const walletLegacy = currentUserData.walletBalance || 0;
    const walletTH = currentUserData.walletBalance_TH || 0;
    const walletEN = currentUserData.walletBalance_EN || 0;
    
    // 2. Fetch Gross Sales (For display only)
    const grossTH = currentUserData.grossSales_TH || 0;
    const grossEN = currentUserData.grossSales_EN || 0;

    // 3. Display Breakdown (Inject HTML)
    const breakdownDiv = document.getElementById('withdraw-breakdown');
    const totalNet = walletLegacy + walletTH + walletEN;
    
    // Calculate Platform Fee and Gross based on current net (Tax is 0% for now)
    const totalPlatformFee = 
        (grossTH * (1 - SHARE_RATE_TH)) + 
        (grossEN * (1 - SHARE_RATE_EN));
    const totalGross = grossTH + grossEN + (walletLegacy > 0 ? (walletLegacy / SHARE_RATE_TH) : 0);

    // Tax calculation
    const taxDeduction = totalNet * TAX_RATE;
    const finalNet = totalNet - taxDeduction;
    if (breakdownDiv) {
        breakdownDiv.classList.remove('hidden');
        breakdownDiv.innerHTML = `
            <h4 class="font-bold text-slate-700 mb-2">สรุปรายได้แยกตามประเภท (Breakdown)</h4>
            <div class="grid grid-cols-2 gap-4 text-xs">
                <div>
                    <p class="font-semibold text-red-600">🇹🇭 นิยายไทย (70%)</p>
                    <p>ยอดขายรวม: ฿${grossTH.toFixed(2)}</p>
                     <p class="font-bold">รายได้สุทธิ: ฿${walletTH.toFixed(2)}</p>
                </div>
                <div>
                    <p class="font-semibold text-blue-600">🇺🇸 นิยายแปล (80%)</p>
                    <p>ยอดขายรวม: ฿${grossEN.toFixed(2)}</p>
                    <p class="font-bold">รายได้สุทธิ: ฿${walletEN.toFixed(2)}</p>
                </div>
            </div>
            ${walletLegacy > 0 ? `<div class="mt-2 pt-2 border-t border-sky-200"><p class="text-xs text-slate-400 font-bold">รายได้สะสมเก่า (Legacy): ฿${walletLegacy.toFixed(2)}</p></div>` : ''}
        `;
    }

    // 4. Update Main Table UI
    document.getElementById('withdraw-gross').textContent = `฿${totalGross.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('withdraw-fee').textContent = `-฿${totalPlatformFee.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('withdraw-pretax').textContent = `฿${totalNet.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    if (TAX_RATE > 0) {
        document.getElementById('withdraw-tax-row').classList.remove('hidden');
        document.getElementById('withdraw-tax').textContent = `-฿${taxDeduction.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    } else {
        document.getElementById('withdraw-tax-row').classList.add('hidden');
    }

    document.getElementById('withdraw-net').textContent = `฿${finalNet.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const bankInfo = currentUserData.bankDetails || {};
    document.getElementById('withdraw-bank-info').value = 
        `${bankInfo.bankName || '-'} / ${bankInfo.accountNumber || '-'} / ${bankInfo.accountName || '-'}`;
}

window.confirmWithdrawal = async function() {
    if (!currentUser || !currentUserData) return;
    const totalNet = (currentUserData.walletBalance || 0) + 
                     (currentUserData.walletBalance_TH || 0) + 
                     (currentUserData.walletBalance_EN || 0);
    if (totalNet < 100) { 
        Swal.fire('ยอดเงินไม่พอ', 'ต้องมีรายได้สะสมขั้นต่ำ 100 บาทเพื่อถอน', 'warning');
        return;
    }
    
    const bankInfo = currentUserData.bankDetails || {};
    Swal.fire({
        title: 'ยืนยันการถอนเงิน?',
        text: `ยอดถอนสุทธิ: ฿${totalNet.toLocaleString('en-US', {minimumFractionDigits: 2})} จะถูกส่งเข้าบัญชี ${bankInfo.bankName}`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'ยืนยัน',
        showLoaderOnConfirm: true,
        preConfirm: async () => {
            try {
                // 1. Record Withdrawal Request
                await addDoc(collection(db, 'withdrawals'), {
                    userId: currentUser.uid,
                    username: currentUserData.username,
                    amount: totalNet,
                    amountTH: currentUserData.walletBalance_TH || 0,
                    amountEN: currentUserData.walletBalance_EN || 0,
                    amountLegacy: currentUserData.walletBalance || 0,
                    bankDetails: bankInfo,
                    requestedAt: serverTimestamp(),
                    status: 'Pending',
                    processedBy: null,
                });
                // 2. Reset Writer's Wallets
                await updateDoc(doc(db, "users", currentUser.uid), {
                    walletBalance: 0,
                    walletBalance_TH: 0,
                    walletBalance_EN: 0,
                });
                
                // 3. Update local data and UI
                currentUserData.walletBalance = 0;
                currentUserData.walletBalance_TH = 0;
                currentUserData.walletBalance_EN = 0;
                
                // 4. Update Admin Badge
                window.updateAdminWithdrawalBadge();
            } catch (error) {
                console.error("Withdrawal submission error:", error);
                Swal.showValidationMessage(`เกิดข้อผิดพลาด: ${error.message}`);
            }
        },
        allowOutsideClick: () => !Swal.isLoading()
    }).then((result) => {
        if (result.isConfirmed) {
            Swal.fire({
                title: 'ส่งคำร้องสำเร็จ!',
                text: 'คำร้องของคุณจะถูกดำเนินการภายใน 3-5 วันทำการ',
                icon: 'success'
            }).then(() => {
                window.showPage('page-writer-dashboard');
                window.loadWriterDashboard(); // Reload dashboard to show zero balance
            });
        }
    });
}

window.loadAdminWithdrawals = async function() {
    const container = document.getElementById('admin-withdrawal-list');
    const badge = document.getElementById('pending-count-display');
    if (!container || !currentUserData || currentUserData.role !== 'admin') return;
    
    // Clear the container before loading both lists
    container.innerHTML = '';
    
    try {
        const q = query(collection(db, "withdrawals"), where("status", "==", "Pending"), orderBy("requestedAt", "asc"));
        const snap = await getDocs(q);
        
        const count = snap.size;
        // The badge text will be updated by updateAdminWithdrawalBadge() at the end
        
        const headerDiv = document.createElement('div');
        headerDiv.innerHTML = '<h3 class="text-xl font-bold text-slate-700 mt-0 mb-4 border-l-4 border-red-500 pl-3">รายการถอนเงินของนักเขียน</h3>';
        container.appendChild(headerDiv);

        if (snap.empty) {
            container.innerHTML += '<p class="text-center text-slate-400 py-6">ไม่มีคำร้องขอถอนเงินที่รอการอนุมัติ</p>';
        }

        snap.forEach(docSnap => {
            const req = docSnap.data();
            const reqId = docSnap.id;
            const timeStr = req.requestedAt ? new Date(req.requestedAt.toDate()).toLocaleString('th-TH') : 'N/A';
            
            const item = document.createElement('div');
            item.className = 'bg-white p-4 rounded-xl shadow-md border border-red-200 flex flex-col md:flex-row justify-between';
            item.innerHTML = `
                <div class="flex-1 space-y-1 md:pr-4">
                    <p class="font-bold text-lg text-red-700">฿${req.amount.toLocaleString('en-US', {minimumFractionDigits: 2})}</p>
                    <p class="text-sm text-slate-600">โดย: ${req.username} (${req.userId.substring(0, 5)}...)</p>
                    <p class="text-xs text-slate-400">วันที่ร้องขอ: ${timeStr}</p>
                    
                    <div class="mt-2 text-xs text-slate-700">
                        <span class="font-bold">โอนเข้า:</span> ${req.bankDetails.bankName} (${req.bankDetails.accountNumber})
                        <span class="ml-4 font-bold">ชื่อ:</span> ${req.bankDetails.accountName}
                    </div>
                    <div class="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-500">
                        <span class="text-red-600">TH (70%): ฿${req.amountTH.toFixed(2)}</span>
                        <span class="text-blue-600 ml-4">EN (80%): ฿${req.amountEN.toFixed(2)}</span>
                        ${req.amountLegacy > 0 ? `<span class="ml-4 text-slate-500">Legacy: ฿${req.amountLegacy.toFixed(2)}</span>` : ''}
                    </div>
                </div>
                <div class="md:w-40 flex flex-col space-y-2 mt-4 md:mt-0">
                    <button onclick="window.approveWithdrawal('${reqId}')" class="bg-green-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-green-700">
                        อนุมัติ (Approve)
                    </button>
                    <button onclick="window.rejectWithdrawal('${reqId}', '${req.userId}', ${req.amountTH}, ${req.amountEN}, ${req.amountLegacy})" class="bg-slate-100 text-slate-600 py-2 rounded-lg text-sm hover:bg-slate-200">
                        ปฏิเสธ (Reject)
                    </button>
                </div>
            `;
            container.appendChild(item);
        });
        
        // ⭐ CALL TOPUP REQUESTS AFTER WITHDRAWALS ARE LOADED
        window.loadAdminTopupRequests();

    } catch (e) {
        console.error("Load Admin Withdrawals Error:", e);
        // Ensure to append error message, not overwrite the whole container
        container.innerHTML += '<p class="text-center text-red-500 py-6">เกิดข้อผิดพลาดในการโหลดคำร้องถอนเงิน</p>';
    }
}

window.approveWithdrawal = function(reqId) {
    Swal.fire({
        title: 'ยืนยันการโอนเงิน?',
        text: 'เมื่อกดอนุมัติ ระบบจะถือว่าเงินถูกโอนออกไปแล้ว!',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'โอนเงินแล้ว!',
        showLoaderOnConfirm: true,
        preConfirm: async () => {
            try {
                // 1. Update Request Status
                await updateDoc(doc(db, 'withdrawals', reqId), {
                    status: 'Approved',
                    processedAt: serverTimestamp(),
                    processedBy: currentUser.uid,
                });
            } catch (error) {
                Swal.showValidationMessage(`Error: ${error.message}`);
            }
        }
    }).then((result) => {
        if (result.isConfirmed) {
            Swal.fire('อนุมัติสำเร็จ!', 'คำร้องถูกย้ายไปสถานะ Approved แล้ว', 'success');
            window.loadAdminWithdrawals();
            window.updateAdminWithdrawalBadge();
        }
    });
}

window.rejectWithdrawal = function(reqId, userId, amountTH, amountEN, amountLegacy) {
    Swal.fire({
        title: 'ปฏิเสธคำร้อง?',
        text: 'ยอดเงินจะถูกคืนเข้ากระเป๋านักเขียนทั้งหมด',
        icon: 'error',
        showCancelButton: true,
        confirmButtonText: 'ปฏิเสธและคืนเงิน',
        showLoaderOnConfirm: true,
        preConfirm: async () => {
            try {
                // 1. Return Money to User's Wallets
                await updateDoc(doc(db, 'users', userId), {
                    walletBalance_TH: increment(amountTH),
                    walletBalance_EN: increment(amountEN),
                    walletBalance: increment(amountLegacy),
                });
                
                // 2. Update Request Status
                await updateDoc(doc(db, 'withdrawals', reqId), {
                    status: 'Rejected',
                    processedAt: serverTimestamp(),
                    processedBy: currentUser.uid,
                    reason: 'Admin rejected and returned funds.',
                });
            } catch (error) {
                Swal.showValidationMessage(`Error: ${error.message}`);
            }
        }
    }).then((result) => {
        if (result.isConfirmed) {
            Swal.fire('คืนเงินสำเร็จ!', 'ยอดเงินถูกคืนและคำร้องถูกปฏิเสธแล้ว', 'success');
            window.loadAdminWithdrawals(); // Reload list
            window.updateAdminWithdrawalBadge();
        }
    });
}

// ⭐ NEW: Load Pending Topup Requests (Semi-Auto)
window.loadAdminTopupRequests = async function() {
    const container = document.getElementById('admin-withdrawal-list');
    if (!container) return;

    // สร้าง Header แยกส่วน
    const headerDiv = document.createElement('div');
    headerDiv.innerHTML = '<h3 class="text-xl font-bold text-slate-700 mt-8 mb-4 border-l-4 border-indigo-500 pl-3">รายการเติม Point รอตรวจสอบ (Pending Top-ups)</h3>';
    container.appendChild(headerDiv);

    const listDiv = document.createElement('div');
    listDiv.className = "space-y-3";
    container.appendChild(listDiv);

    try {
        const q = query(collection(db, "transactions"), where("status", "==", "pending"), orderBy("timestamp", "asc"));
        const snap = await getDocs(q);

        if (snap.empty) {
            listDiv.innerHTML = '<p class="text-center text-slate-400 py-4 bg-slate-50 rounded-lg">ไม่มีรายการรอตรวจสอบ</p>';
            return;
        }

        snap.forEach(docSnap => {
            const tx = docSnap.data();
            const txId = docSnap.id;
            const timeStr = tx.timestamp ? new Date(tx.timestamp.toDate()).toLocaleString('th-TH') : 'N/A';

            const item = document.createElement('div');
            item.className = 'bg-white p-4 rounded-xl shadow-md border border-indigo-200 flex flex-col md:flex-row justify-between';
            item.innerHTML = `
                <div class="flex-1 space-y-1">
                    <p class="font-bold text-lg text-indigo-700">+${tx.pointsAdded} Points ($${tx.amountUSD})</p>
                    <p class="text-sm text-slate-600">User: ${tx.username}</p>
                    <p class="text-xs text-slate-400">Date: ${timeStr}</p>
                    <p class="text-[10px] text-slate-400 break-all">Stripe Token: ${tx.stripeTokenId}</p>
                </div>
                <div class="md:w-32 flex flex-col space-y-2 mt-4 md:mt-0">
                    <button onclick="window.approveTopup('${txId}', '${tx.userId}', ${tx.pointsAdded})" class="bg-green-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-green-700">Approve</button>
                    <button onclick="window.rejectTopup('${txId}', '${tx.userId}')" class="bg-red-50 text-red-600 py-2 rounded-lg text-sm hover:bg-red-100">Reject</button>
                </div>
            `;
            listDiv.appendChild(item);
        });

    } catch (e) { 
        console.error("Load Topup Error:", e); 
        listDiv.innerHTML = `<p class="text-center text-red-500 py-4 bg-slate-50 rounded-lg">Error loading topup requests.</p>`;
    }
}

// ⭐ NEW: Approve Topup Logic
window.approveTopup = function(txId, userId, points) {
    Swal.fire({
        title: 'ยืนยันการเพิ่ม Point?',
        text: `ลูกค้าจะได้รับ ${points} Points ทันที`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Approve & Add Points',
        confirmButtonColor: '#16a34a',
        showLoaderOnConfirm: true,
        preConfirm: async () => {
            try {
                // 1. Add Points to User
                await updateDoc(doc(db, "users", userId), {
                    balancePoints: increment(points)
                });
                // 2. Update Transaction Status
                await updateDoc(doc(db, "transactions", txId), {
                    status: 'completed',
                    approvedBy: currentUser.uid,
                    approvedAt: serverTimestamp()
                });
                
                // 3. ⭐ NEW: Send User Notification (Success) ⭐
                await addDoc(collection(db, "notifications"), {
                    recipientId: userId, 
                    senderId: currentUser.uid,
                    senderName: currentUserData.username,
                    type: 'point_success', // ประเภทแจ้งเตือนใหม่
                    novelTitle: `Topup: +${points} Points`,
                    chapterNumber: 0,
                    message: `Your point purchase was successfully approved! Enjoy reading.`,
                    read: false,
                    timestamp: serverTimestamp()
                });

            } catch (error) {
                Swal.showValidationMessage(`Error: ${error.message}`);
            }
        }
    }).then((result) => {
        if (result.isConfirmed) {
            Swal.fire('Success', 'เพิ่ม Point เรียบร้อยแล้ว', 'success');
            window.location.reload(); 
        }
    });
}

// ⭐ UPDATED: Reject Topup Logic (เพิ่มการแจ้งเตือน User)
window.rejectTopup = function(txId, userId) {
    Swal.fire({
        title: 'ปฏิเสธรายการ?',
        text: 'รายการนี้จะถูกยกเลิก (ลูกค้าไม่ได้ Point)',
        icon: 'error',
        showCancelButton: true,
        confirmButtonText: 'Reject',
        confirmButtonColor: '#dc2626',
        preConfirm: async () => {
            try {
                // 1. Update Transaction Status
                await updateDoc(doc(db, "transactions", txId), {
                    status: 'rejected',
                    rejectedBy: currentUser.uid,
                    rejectedAt: serverTimestamp()
                });
                
                // 2. ⭐ NEW: Send User Notification (Rejection) ⭐
                 await addDoc(collection(db, "notifications"), {
                    recipientId: userId, 
                    senderId: currentUser.uid,
                    senderName: currentUserData.username,
                    type: 'point_reject', // ประเภทแจ้งเตือนใหม่
                    novelTitle: `Topup: Rejected`,
                    chapterNumber: 0,
                    message: `Your point purchase was rejected. Please contact support via the Contact page if you have been charged.`,
                    read: false,
                    timestamp: serverTimestamp()
                });

            } catch (error) {
                Swal.showValidationMessage(`Error: ${error.message}`);
            }
        }
    }).then((result) => {
        if (result.isConfirmed) {
            Swal.fire('Rejected', 'ปฏิเสธรายการเรียบร้อย', 'success');
            window.location.reload();
        }
    });
}

// ⭐ UPDATED: Update Admin Withdrawal Badge (Pending Count) - Now correctly sums both.
window.updateAdminWithdrawalBadge = async function() {
    const badge = document.getElementById('admin-topup-badge');
    if (!badge || !currentUserData || currentUserData.role !== 'admin') return;

    try {
        const qWithdraw = query(collection(db, "withdrawals"), where("status", "==", "Pending"));
        // Requires Composite Index: status ASC, timestamp ASC
        const qTopup = query(collection(db, "transactions"), where("status", "==", "pending"));
        
        // Use Promise.all to fetch both counts concurrently
        const [snapW, snapT] = await Promise.all([getDocs(qWithdraw), getDocs(qTopup)]);
        const count = snapW.size + snapT.size;

        // Update display text on the admin page
        const pendingCountDisplay = document.getElementById('pending-count-display');
        if(pendingCountDisplay) {
             pendingCountDisplay.textContent = `มีคำร้องที่รอการอนุมัติรวม: ${count} รายการ`;
        }

        if (count > 0) {
            badge.textContent = count;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    } catch (e) { 
        console.error("Admin badge update error:", e);
        // Fallback for display text if error occurs (e.g. Index not ready yet)
        const pendingCountDisplay = document.getElementById('pending-count-display');
        if(pendingCountDisplay) {
             pendingCountDisplay.textContent = `มีคำร้องที่รอการอนุมัติรวม: Error!`;
        }
    }
}


// ============================================================
//  5. INIT & AUTH
// ============================================================
window.onload = function() {
    try {
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);
        console.log("Firebase initialized. App JS Loaded v3");
    } catch (error) { console.error("Firebase Init Error:", error); }

    onAuthStateChanged(auth, user => {
        if (user) {
            currentUser = user;
            getDoc(doc(db, 'users', user.uid)).then(docSnap => {
                if (docSnap.exists()) {
                    currentUserData = docSnap.data();
                    const loggedOut = document.getElementById('auth-logged-out');
                    const loggedIn = document.getElementById('auth-logged-in');
                    if(loggedOut) loggedOut.style.display = 'none';
                    if(loggedIn) loggedIn.style.display = 'flex';
                    const nameEl = document.getElementById('user-username');
                    if(nameEl) nameEl.textContent = currentUserData.username;
                    
                    const pointEl = document.getElementById('user-points');
                    if(pointEl) pointEl.textContent = `${currentUserData.balancePoints || 0} Points`;

                    // --- จัดการปุ่มเมนูตาม Role ---
                    const adminNotifyBtn = document.getElementById('admin-notify-btn');
                    const adminSettingsBtn = document.getElementById('admin-settings-btn');
                    const adminTopupBtn = document.getElementById('admin-topup-btn');
                    const role = (currentUserData.role || '').toLowerCase();

                    // 1. แสดงกระดิ่งแจ้งเตือน (สำหรับทุกคนที่ล็อกอิน) ✅ แก้ไขตรงนี้
                    if(adminNotifyBtn) {
                        adminNotifyBtn.style.display = 'block';
                        window.updateNotificationBadge();
                    }

                    // 2. ปุ่ม Dashboard (สำหรับ Writer และ Admin)
                    if(role === 'writer' || role === 'admin') {
                        if(adminSettingsBtn) adminSettingsBtn.style.display = 'block';
                    } else {
                        if(adminSettingsBtn) adminSettingsBtn.style.display = 'none';
                    }

                    // 3. ปุ่มจัดการเงิน (สำหรับ Admin เท่านั้น)
                    if(role === 'admin') {
                        if(adminTopupBtn) {
                            adminTopupBtn.style.display = 'block';
                            window.updateAdminWithdrawalBadge();
                        }
                    } else {
                        if(adminTopupBtn) adminTopupBtn.style.display = 'none';
                    }

                    loadNovels();
                }
            });
        } else {
            currentUser = null;
            currentUserData = null;
            const loggedOut = document.getElementById('auth-logged-out');
            const loggedIn = document.getElementById('auth-logged-in');
            if(loggedOut) loggedOut.style.display = 'flex';
            if(loggedIn) loggedIn.style.display = 'none';
            loadNovels();
        }
    });

    const loginForm = document.getElementById('login-form');
    if(loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            signInWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-password').value)
                .then(() => { window.showPage('page-home'); Swal.fire('Welcome Back', '', 'success'); })
                .catch(err => Swal.fire('Error', err.message, 'error'));
        });
    }

    const regForm = document.getElementById('register-form');
    if(regForm) {
        regForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = document.getElementById('reg-email').value;
            const pass = document.getElementById('reg-password').value;
            const user = document.getElementById('reg-username').value;
            createUserWithEmailAndPassword(auth, email, pass).then((cred) => {
                setDoc(doc(db, 'users', cred.user.uid), { username: user, email: email, balancePoints: 0, role: 'user', createdAt: Timestamp.now() })
                .then(() => { window.showPage('page-home'); Swal.fire('Success', 'Account created!', 'success'); });
            }).catch(err => Swal.fire('Error', err.message, 'error'));
        });
    }

    const writerRegForm = document.getElementById('writer-register-form');
    if(writerRegForm) {
        writerRegForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!currentUser) {
                Swal.fire({
                    icon: 'warning',
                    title: 'Login Required',
                    text: 'กรุณาล็อกอินด้วยบัญชีผู้ใช้ของคุณก่อนสมัครเป็นนักเขียน',
                    confirmButtonText: 'ไปหน้า Login'
                }).then(() => {
                   window.showPage('page-login');
                });
                return;
            }
            
            const bankDetails = {
               accountName: document.getElementById('writer-realname').value,
                bankName: document.getElementById('writer-bank-name').value,
                accountNumber: document.getElementById('writer-bank-acc').value,
                idCard: document.getElementById('writer-id-card').value
            };
            try {
                await updateDoc(doc(db, "users", currentUser.uid), {
                    role: 'writer', 
                    bankDetails: bankDetails, 
                    // Initial Wallets (crucial for the new system)
                    walletBalance: 0, 
                    walletBalance_TH: 0,
                    walletBalance_EN: 0,
                    grossSales_TH: 0,
                    grossSales_EN: 0,
                   registeredAt: Timestamp.now()
                });
                Swal.fire('ยินดีต้อนรับ!', 'คุณเป็นนักเขียนเรียบร้อยแล้ว', 'success')
                .then(() => window.location.reload());
            } catch (error) { 
                console.error(error);
                Swal.fire('Error', 'ไม่สามารถบันทึกข้อมูลได้: ' + error.message, 'error');
            }
        });
    }

    const addNovelForm = document.getElementById('add-novel-form');
    if(addNovelForm) {
        addNovelForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const categoryVal = document.getElementById('novel-category').value;
            const data = {
                title_en: document.getElementById('novel-title-en').value,
                title_th: document.getElementById('novel-title-th').value,
                title_original: document.getElementById('novel-title-original').value,
                author: document.getElementById('novel-author').value,
                coverImageUrl: document.getElementById('novel-cover-url').value,
                description: document.getElementById('novel-description-editor').innerHTML,
                status: document.getElementById('novel-status').value,
                categories: categoryVal ? [categoryVal] : ['General'],
                authorId: currentUser.uid, 
                // ⭐ Save Language Choice
                language: document.getElementById('novel-language').value, 
                lastChapterUpdatedAt: Timestamp.now()
            };
            try {
                if (currentEditingNovelId) {
                    await updateDoc(doc(db, 'novels', currentEditingNovelId), data);
                    Swal.fire('Updated', 'อัปเดตนิยายเรียบร้อยแล้ว', 'success');
                } else {
                    data.createdAt = Timestamp.now();
                    await addDoc(collection(db, 'novels'), data);
                    Swal.fire('Success', 'บันทึกนิยายใหม่เรียบร้อยแล้ว', 'success');
                }
                window.setAdminNovelMode('add');
                loadNovels();
                
                const role = (currentUserData.role || '').toLowerCase();
                if(role === 'writer' || role === 'admin') window.loadWriterDashboard();
            } catch(err) { 
                console.error(err);
                Swal.fire('Error', 'บันทึกไม่สำเร็จ: ' + err.message, 'error'); 
            }
        });
    }

    const addChapterForm = document.getElementById('add-chapter-form');
    if(addChapterForm) {
        addChapterForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const novelId = document.getElementById('chapter-novel-select').value;
            if(!novelId) { Swal.fire('Error', 'กรุณาเลือกนิยาย (Select Novel)', 'warning'); return; }

            const scheduleInput = document.getElementById('chapter-schedule').value;
            let publishTime = Timestamp.now();
            if (scheduleInput) {
                publishTime = Timestamp.fromDate(new Date(scheduleInput));
            }

            const chapterData = {
                novelId: novelId,
                authorId: currentUser.uid, 
                chapterNumber: parseInt(document.getElementById('chapter-number').value),
                title: document.getElementById('chapter-title').value,
                pointCost: parseInt(document.getElementById('chapter-point-type').value),
                content: document.getElementById('chapter-content-editor').innerHTML, 
                publishedAt: publishTime, 
            };
            try {
                if (currentEditingChapterId) {
                    await updateDoc(doc(db, 'chapters', currentEditingChapterId), chapterData);
                    Swal.fire('Updated', 'อัปเดตตอนเรียบร้อยแล้ว', 'success');
                } else {
                    chapterData.createdAt = Timestamp.now();
                    await addDoc(collection(db, 'chapters'), chapterData);
                    Swal.fire('Success', 'บันทึกตอนเรียบร้อยแล้ว', 'success');
                }
 
                if (!scheduleInput || new Date(scheduleInput) <= new Date()) {
                    await updateDoc(doc(db, 'novels', novelId), { lastChapterUpdatedAt: Timestamp.now() });
                }
                
                e.target.reset();
                window.setAdminChapterMode('add', true); 
                window.loadNovelChaptersForAdmin(novelId);
                const role = (currentUserData.role || '').toLowerCase();
                if(role === 'writer' || role === 'admin') window.loadWriterDashboard();
            } catch (err) { 
                console.error(err);
                Swal.fire('Error', 'บันทึกไม่สำเร็จ: ' + err.message, 'error'); 
            }
        });
    }

    // ⭐ NEW: Payment/Topup Form Handler (Semi-Auto Mode)
    const topupForm = document.getElementById('topup-form');
    if(topupForm) {
        topupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!currentUser) { Swal.fire('Login Required', '', 'warning'); return; }
            if (!stripe || !cardElement) { Swal.fire('Error', 'Stripe not initialized', 'error'); return; }

            // 1. Get Selected Package
            const selectedPackage = document.querySelector('input[name="topup-package"]:checked');
            if(!selectedPackage) { Swal.fire('Error', 'Please select a package', 'error'); return; }

            const price = parseFloat(selectedPackage.value);
            let pointsToAdd = 0;

            switch(price) {
                case 0.99: pointsToAdd = 50; break;
                case 4.99: pointsToAdd = 265; break;
                case 9.99: pointsToAdd = 550; break;
                case 19.99: pointsToAdd = 1125; break;
                case 49.99: pointsToAdd = 2900; break;
                default: pointsToAdd = 0;
            }

            // 2. Create Token
            const { token, error } = await stripe.createToken(cardElement);

            if (error) {
                const errorElement = document.getElementById('card-errors');
                errorElement.textContent = error.message;
                return;
            }

            // 3. Semi-Auto Processing: Save to DB as 'pending'
            Swal.fire({
                title: 'Processing Payment...',
                text: 'Please wait...',
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            });

            setTimeout(async () => {
                try {
                    // Record Transaction as PENDING
                    await addDoc(collection(db, "transactions"), {
                        userId: currentUser.uid,
                        username: currentUserData.username,
                        amountUSD: price,
                        pointsAdded: pointsToAdd,
                        stripeTokenId: token.id, // Evidence for Admin
                        timestamp: serverTimestamp(),
                        status: 'pending' // ⭐ Wait for Admin Approval
                    });

                    // แจ้งเตือนภาษาอังกฤษตามที่ขอ
                    Swal.fire({
                        icon: 'info',
                        title: 'Payment Received',
                        text: 'System will verify and add points within 24 hours.',
                        confirmButtonText: 'OK'
                    }).then(() => {
                        window.showPage('page-home');
                        // No reload here to prevent losing the Swall message instantly
                    });

                } catch (err) {
                    console.error("Topup Error:", err);
                    Swal.fire('Error', 'Transaction failed: ' + err.message, 'error');
                }
            }, 1000);
        });
    }

    // ⭐⭐ Setup Password Toggles ⭐⭐
    const setupPasswordToggle = (btnId, inputId) => {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (btn && input) {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const isPassword = input.type === 'password';
                input.type = isPassword ? 'text' : 'password';
                // Toggle Icon
                btn.innerHTML = `<i data-lucide="${isPassword ? 'eye' : 'eye-off'}" class="w-5 h-5"></i>`;
                if(window.lucide) window.lucide.createIcons();
            });
        }
    };

    setupPasswordToggle('login-toggle-password', 'login-password');
    setupPasswordToggle('reg-toggle-password', 'reg-password');
    setupPasswordToggle('reg-confirm-toggle-password', 'reg-confirm-password');

    if (window.lucide) window.lucide.createIcons();
};