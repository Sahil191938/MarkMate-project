const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads/photos', express.static(path.join(__dirname, 'uploads', 'photos')));

// Ensure upload directories exist
const ensureDir = (dirPath) => {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
};
ensureDir(path.join(__dirname, 'uploads'));
ensureDir(path.join(__dirname, 'uploads', 'submissions'));
ensureDir(path.join(__dirname, 'uploads', 'timetables'));
ensureDir(path.join(__dirname, 'uploads', 'photos'));

// Multer setup for submissions, timetables, and photos
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		if (req.path.includes('timetable')) {
			cb(null, path.join(__dirname, 'uploads', 'timetables'));
		} else if (req.path.includes('photo') || req.path.includes('user')) {
			cb(null, path.join(__dirname, 'uploads', 'photos'));
		} else {
			cb(null, path.join(__dirname, 'uploads', 'submissions'));
		}
	},
	filename: (req, file, cb) => {
		const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
		const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
		cb(null, unique + '-' + safe);
	}
});
const upload = multer({ storage });

// SQLite setup
const dbPath = path.join(__dirname, 'portal.db');
const db = new sqlite3.Database(dbPath);

const run = (sql, params = []) => new Promise((resolve, reject) => {
	db.run(sql, params, function (err) {
		if (err) return reject(err);
		resolve(this);
	});
});

const all = (sql, params = []) => new Promise((resolve, reject) => {
	db.all(sql, params, (err, rows) => {
		if (err) return reject(err);
		resolve(rows);
	});
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
	db.get(sql, params, (err, row) => {
		if (err) return reject(err);
		resolve(row);
	});
});

// Simple session storage (in-memory for now)
const sessions = new Map();

// Authentication middleware
const requireAuth = (requiredRole) => {
	return async (req, res, next) => {
		const sessionId = req.headers['x-session-id'] || req.query.sessionId;
		if (!sessionId || !sessions.has(sessionId)) {
			return res.status(401).json({ error: 'Unauthorized' });
		}
		const session = sessions.get(sessionId);
		if (requiredRole && session.role !== requiredRole) {
			return res.status(403).json({ error: 'Forbidden' });
		}
		req.user = session;
		next();
	};
};

// Initialize schema
async function initDb() {
	await run(`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		role TEXT CHECK(role IN ('student','teacher')) NOT NULL,
		photo_path TEXT
	)`);
	
	// Add photo_path column if it doesn't exist (for existing databases)
	try {
		const tableInfo = await all("PRAGMA table_info(users)");
		const hasPhotoPath = tableInfo.some(col => col.name === 'photo_path');
		if (!hasPhotoPath) {
			await run('ALTER TABLE users ADD COLUMN photo_path TEXT');
			console.log('Added photo_path column to users table');
		}
	} catch (e) {
		// Column might already exist, which is fine
		console.log('Column check completed');
	}

	await run(`CREATE TABLE IF NOT EXISTS assignments (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL,
		description TEXT,
		due_at TEXT NOT NULL,
		created_by INTEGER NOT NULL,
		FOREIGN KEY(created_by) REFERENCES users(id)
	)`);

	await run(`CREATE TABLE IF NOT EXISTS submissions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		assignment_id INTEGER NOT NULL,
		student_id INTEGER NOT NULL,
		file_path TEXT NOT NULL,
		submitted_at TEXT NOT NULL,
		marks INTEGER,
		FOREIGN KEY(assignment_id) REFERENCES assignments(id),
		FOREIGN KEY(student_id) REFERENCES users(id)
	)`);

	await run(`CREATE TABLE IF NOT EXISTS timetable (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		day TEXT NOT NULL,
		period TEXT NOT NULL,
		subject TEXT NOT NULL,
		teacher_id INTEGER NOT NULL,
		FOREIGN KEY(teacher_id) REFERENCES users(id)
	)`);

	await run(`CREATE TABLE IF NOT EXISTS attendance (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		student_id INTEGER NOT NULL,
		date TEXT NOT NULL,
		present INTEGER NOT NULL CHECK(present IN (0,1)),
		UNIQUE(student_id, date),
		FOREIGN KEY(student_id) REFERENCES users(id)
	)`);

	// Seed some users if empty
	const count = await get('SELECT COUNT(*) as c FROM users');
	if ((count?.c || 0) === 0) {
		await run('INSERT INTO users (name, role) VALUES ("Alice", "student"), ("Bob", "student"), ("Prof. Rao", "teacher"), ("Dr. Singh", "teacher")');
	}
}

// Authentication API
app.post('/api/auth/login', async (req, res) => {
	try {
		const { user_id, password, role } = req.body;
		if (!user_id || !password || !role) {
			return res.status(400).json({ error: 'Missing required fields' });
		}

		// Verify user exists and has correct role
		const user = await get('SELECT * FROM users WHERE id = ? AND role = ?', [user_id, role]);
		if (!user) {
			return res.status(401).json({ error: 'Invalid credentials' });
		}

		// For now, accept any password (just require it to be provided)
		// In future, you can add password hashing here
		
		// Create session
		const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
		sessions.set(sessionId, {
			user_id: user.id,
			name: user.name,
			role: user.role,
			createdAt: Date.now()
		});

		res.json({ 
			success: true, 
			sessionId: sessionId,
			name: user.name,
			role: user.role
		});
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post('/api/auth/logout', (req, res) => {
	const sessionId = req.headers['x-session-id'] || req.body.sessionId;
	if (sessionId) {
		sessions.delete(sessionId);
	}
	res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
	const sessionId = req.headers['x-session-id'] || req.query.sessionId;
	if (!sessionId || !sessions.has(sessionId)) {
		return res.status(401).json({ authenticated: false });
	}
	const session = sessions.get(sessionId);
	res.json({ authenticated: true, user: session });
});

// Users API
app.get('/api/users', async (req, res) => {
	try {
		const { role } = req.query;
		const rows = role ? await all('SELECT * FROM users WHERE role = ?', [role]) : await all('SELECT * FROM users');
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post('/api/users', async (req, res) => {
	try {
		const { name, role } = req.body;
		if (!name || !role || !['student','teacher'].includes(role)) {
			return res.status(400).json({ error: 'name and valid role required' });
		}
		const result = await run('INSERT INTO users (name, role) VALUES (?,?)', [name, role]);
		const user = await get('SELECT * FROM users WHERE id = ?', [result.lastID]);
		res.json(user);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.put('/api/users/:id', upload.single('photo'), async (req, res) => {
	try {
		const userId = req.params.id;
		const { name } = req.body;
		
		// Check if user exists
		const existingUser = await get('SELECT * FROM users WHERE id = ?', [userId]);
		if (!existingUser) {
			return res.status(404).json({ error: 'User not found' });
		}
		
		// Build update query
		const updates = [];
		const params = [];
		
		if (name) {
			updates.push('name = ?');
			params.push(name);
		}
		
		if (req.file) {
			// Delete old photo if exists
			if (existingUser.photo_path) {
				const oldPhotoPath = path.join(__dirname, 'uploads', 'photos', existingUser.photo_path);
				if (fs.existsSync(oldPhotoPath)) {
					fs.unlinkSync(oldPhotoPath);
				}
			}
			updates.push('photo_path = ?');
			params.push(req.file.filename);
		}
		
		if (updates.length === 0) {
			return res.status(400).json({ error: 'No fields to update' });
		}
		
		params.push(userId);
		await run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
		
		const updatedUser = await get('SELECT * FROM users WHERE id = ?', [userId]);
		res.json(updatedUser);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.get('/api/users/:id', async (req, res) => {
	try {
		const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
		if (!user) {
			return res.status(404).json({ error: 'User not found' });
		}
		res.json(user);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// Assignments
app.get('/api/assignments', async (req, res) => {
	try {
		const rows = await all('SELECT a.*, u.name as teacher_name FROM assignments a JOIN users u ON a.created_by = u.id ORDER BY datetime(due_at) ASC');
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post('/api/assignments', async (req, res) => {
	try {
		const { title, description, due_at, teacher_id } = req.body;
		if (!title || !due_at || !teacher_id) return res.status(400).json({ error: 'Missing required fields' });
		await run('INSERT INTO assignments (title, description, due_at, created_by) VALUES (?,?,?,?)', [title, description || '', due_at, teacher_id]);
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// Submissions
app.post('/api/submissions', upload.single('file'), async (req, res) => {
	try {
		const { assignment_id, student_id } = req.body;
		if (!assignment_id || !student_id || !req.file) return res.status(400).json({ error: 'Missing fields or file' });

		const assignment = await get('SELECT due_at FROM assignments WHERE id = ?', [assignment_id]);
		if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

		const submittedAt = new Date().toISOString();
		const dueAt = new Date(assignment.due_at).toISOString();
		if (submittedAt > dueAt) {
			// Allow late submissions but mark later if needed
		}

		await run('INSERT INTO submissions (assignment_id, student_id, file_path, submitted_at) VALUES (?,?,?,?)', [assignment_id, student_id, req.file.filename, submittedAt]);
		res.json({ ok: true, file: req.file.filename });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.get('/api/submissions', async (req, res) => {
	try {
		const { assignment_id } = req.query;
		if (!assignment_id) return res.status(400).json({ error: 'assignment_id required' });
		const rows = await all(`SELECT s.*, u.name as student_name FROM submissions s JOIN users u ON s.student_id = u.id WHERE s.assignment_id = ? ORDER BY datetime(submitted_at) ASC`, [assignment_id]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.get('/api/submissions/:id/download', async (req, res) => {
	try {
		const row = await get('SELECT file_path FROM submissions WHERE id = ?', [req.params.id]);
		if (!row) return res.status(404).json({ error: 'Not found' });
		const fileFullPath = path.join(__dirname, 'uploads', 'submissions', row.file_path);
		return res.download(fileFullPath);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post('/api/submissions/:id/mark', async (req, res) => {
	try {
		const { marks } = req.body;
		await run('UPDATE submissions SET marks = ? WHERE id = ?', [marks, req.params.id]);
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.get('/api/marks', async (req, res) => {
	try {
		const { student_id } = req.query;
		if (!student_id) return res.status(400).json({ error: 'student_id required' });
		const rows = await all(`SELECT a.title, a.due_at, s.marks, s.submitted_at FROM submissions s JOIN assignments a ON s.assignment_id = a.id WHERE s.student_id = ? ORDER BY datetime(a.due_at) DESC`, [student_id]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// Timetable
app.get('/api/timetable', async (req, res) => {
	try {
		const rows = await all('SELECT * FROM timetable ORDER BY day, period');
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.post('/api/timetable', async (req, res) => {
	try {
		const { entries, teacher_id } = req.body; // entries: [{day, period, subject}]
		if (!Array.isArray(entries) || !teacher_id) return res.status(400).json({ error: 'Invalid body' });
		await run('DELETE FROM timetable');
		for (const e of entries) {
			if (e.day && e.period && e.subject) {
				// eslint-disable-next-line no-await-in-loop
				await run('INSERT INTO timetable (day, period, subject, teacher_id) VALUES (?,?,?,?)', [e.day, e.period, e.subject, teacher_id]);
			}
		}
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// Optional: upload a timetable file (PDF)
app.post('/api/timetable/upload', upload.single('file'), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: 'file required' });
		res.json({ ok: true, file: `/uploads/timetables/${req.file.filename}` });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// Latest timetable PDF
app.get('/api/timetable/file', async (req, res) => {
    try {
        const dir = path.join(__dirname, 'uploads', 'timetables');
        if (!fs.existsSync(dir)) return res.json({ file: null });
        const files = fs.readdirSync(dir)
            .filter(f => !f.startsWith('.'))
            .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a,b) => b.t - a.t);
        const latest = files[0]?.f || null;
        res.json({ file: latest ? `/uploads/timetables/${latest}` : null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Attendance
app.post('/api/attendance/mark', async (req, res) => {
	try {
		const { date, marks } = req.body; // marks: [{student_id, present}]
		if (!date || !Array.isArray(marks)) return res.status(400).json({ error: 'Invalid body' });
		for (const m of marks) {
			if (m.student_id == null || m.present == null) continue;
			// eslint-disable-next-line no-await-in-loop
			await run('INSERT INTO attendance (student_id, date, present) VALUES (?,?,?) ON CONFLICT(student_id, date) DO UPDATE SET present=excluded.present', [m.student_id, date, m.present ? 1 : 0]);
		}
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

app.get('/api/attendance', async (req, res) => {
	try {
		const { student_id } = req.query;
		if (!student_id) return res.status(400).json({ error: 'student_id required' });
		const rows = await all('SELECT date, present FROM attendance WHERE student_id = ? ORDER BY date DESC', [student_id]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// Fallback to index.html
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'index.html'));
});

initDb()
	.then(() => {
		console.log('Database initialized successfully');
		const server = app.listen(PORT, '0.0.0.0', () => {
			console.log(`Server running on http://localhost:${PORT}`);
			console.log(`Server also accessible on http://127.0.0.1:${PORT}`);
		});
		server.on('error', (err) => {
			console.error('Server startup error:', err);
			if (err.code === 'EADDRINUSE') {
				console.error(`Port ${PORT} is already in use. Please stop the other application or change the port.`);
			}
			process.exit(1);
		});
	})
	.catch((e) => {
		console.error('DB init failed', e);
		console.error('Error stack:', e.stack);
		process.exit(1);
	});


