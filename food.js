import express from "express";
import session from "express-session";
import mysql from "mysql2/promise";
import path from "path";
import multer from 'multer';
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";
import dotenv from "dotenv";
import bcrypt from "bcrypt"; 
dotenv.config();

// -------------------------------------------------------------
// Пути
// -------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------
// Express
// -------------------------------------------------------------
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -------------------------------------------------------------
// Сессии
// -------------------------------------------------------------
app.use(
    session({
        secret: process.env.SESSION_SECRET || "secret123",
        resave: false,
        saveUninitialized: false
    })
);

// Чтобы user был доступен в любом шаблоне как {{user}}
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// -------------------------------------------------------------
// Handlebars
// -------------------------------------------------------------
app.engine(
    "hbs",
    engine({
        extname: ".hbs",
        defaultLayout: "main",
        layoutsDir: path.join(__dirname, "views", "layouts"),
        partialsDir: path.join(__dirname, "views", "partials"),
        helpers: {
            eq(a, b) {
                return a == b;
            },
            or(a, b) {
                return a || b;
            },
            includes(arr, value) {
                return Array.isArray(arr) && arr.includes(value);
            },
            ifEquals(a, b, options) {
                return a == b ? options.fn(this) : options.inverse(this);
            },
            formatDate(dateString) {
                if (!dateString) return '';
                const date = new Date(dateString);
                return date.toLocaleDateString('ru-RU', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            }   
        }
    })
);

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// -------------------------------------------------------------
// База данных
// -------------------------------------------------------------
const db = await mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME || "recipes"
});

export default db;

// -------------------------------------------------------------
// УТИЛИТЫ ДЛЯ УВЕДОМЛЕНИЙ
// -------------------------------------------------------------

// Создание уведомления
async function createNotification(userId, text, link = null) {
    try {
        await db.query(
            "INSERT INTO notifications (user_id, text, link) VALUES (?, ?, ?)",
            [userId, text, link]
        );
    } catch (err) {
        console.error("Ошибка при создании уведомления:", err);
    }
}

// Получение уведомлений пользователя
async function getUserNotifications(userId, limit = 10) {
    try {
        const [notifications] = await db.query(
            "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            [userId, limit]
        );
        return notifications;
    } catch (err) {
        console.error("Ошибка при получении уведомлений:", err);
        return [];
    }
}

// Получение количества непрочитанных уведомлений
async function getUnreadCount(userId) {
    try {
        const [[result]] = await db.query(
            "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE",
            [userId]
        );
        return result.count;
    } catch (err) {
        console.error("Ошибка при подсчете непрочитанных:", err);
        return 0;
    }
}

// Пометить уведомление как прочитанное
async function markAsRead(notificationId, userId) {
    try {
        await db.query(
            "UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?",
            [notificationId, userId]
        );
    } catch (err) {
        console.error("Ошибка при отметке как прочитанного:", err);
    }
}

// Пометить все уведомления как прочитанные
async function markAllAsRead(userId) {
    try {
        await db.query(
            "UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE",
            [userId]
        );
    } catch (err) {
        console.error("Ошибка при отметке всех как прочитанных:", err);
    }
}

// Настройка multer для загрузки изображений
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, 'public/uploads');
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
        }
    }),
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (extname && mimetype) cb(null, true);
        else cb(new Error("Только изображения"));
    }
});


////////////////////////////////////////////////////////////
// MIDDLEWARE — доступ
////////////////////////////////////////////////////////////

// Добавим в существующий middleware проверки аутентификации
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect("/login");
    }
    
    if (req.session.user.is_banned) {
        req.session.destroy((err) => {
            if (err) console.error(err);
            return res.render("login", {
                title: "Вход",
                error: "Ваш аккаунт заблокирован. Обратитесь к администратору."
            });
        });
    }
    
    next();
};

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).send("Доступ запрещён");
    }
    next();
}

async function requireOwnerOrAdmin(req, res, next) {
    if (!req.session.user) return res.redirect("/login");

    const recipeId = req.params.id;
    const [rows] = await db.query(
        "SELECT user_id FROM recipes WHERE id = ? LIMIT 1",
        [recipeId]
    );

    if (!rows.length) return res.status(404).send("Рецепт не найден");

    const recipeOwner = rows[0].user_id;
    const currentUser = req.session.user;

    if (currentUser.role === "admin" || currentUser.id === recipeOwner) {
        return next();
    }

    return res.status(403).send("У вас нет прав для редактирования");
}

function dynamicUpload(req, res, next) {
    const upload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, 'public/uploads');
            },
            filename: (req, file, cb) => {
                const ext = path.extname(file.originalname);
                cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
            }
        }),
        fileFilter: (req, file, cb) => {
            const filetypes = /jpeg|jpg|png|gif/;
            const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
            const mimetype = filetypes.test(file.mimetype);
            if (extname && mimetype) cb(null, true);
            else cb(new Error("Только изображения"));
        }
    }).fields([
        { name: "image", maxCount: 1 },
        // Динамически добавляем поля для шагов
        ...Array.from({ length: 20 }, (_, i) => ({ name: `step_images_${i}`, maxCount: 1 }))
    ]);
    
    upload(req, res, next);
}

// Добавляем уведомления в locals
app.use(async (req, res, next) => {
    res.locals.user = req.session.user || null;
    
    if (req.session.user) {
        try {
            // Количество непрочитанных уведомлений
            const unreadCount = await getUnreadCount(req.session.user.id);
            res.locals.notificationCount = unreadCount;
            
            // Последние 5 уведомлений
            const notifications = await getUserNotifications(req.session.user.id, 5);
            res.locals.notifications = notifications;
        } catch (err) {
            console.error("Ошибка при загрузке уведомлений:", err);
            res.locals.notificationCount = 0;
            res.locals.notifications = [];
        }
    } else {
        res.locals.notificationCount = 0;
        res.locals.notifications = [];
    }
    
    next();
});
// ---------------------------------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------------------------------

// Главная
app.get("/", (req, res) => {
    res.redirect("/recipes");
});

// ------------------------
// Вход
// ------------------------
app.get("/login", (req, res) => {
    res.render("login", { title: "Вход" });
});

app.post("/login", async (req, res) => {
    const { login, password } = req.body;

    const [rows] = await db.query(
        "SELECT * FROM users WHERE login = ? LIMIT 1",
        [login]
    );

    if (!rows.length) {
        return res.render("login", {
            title: "Вход",
            error: "Неверный логин или пароль"
        });
    }

    const user = rows[0];
    
    // Проверка на бан пользователя
    if (user.is_banned) {
        return res.render("login", {
            title: "Вход",
            error: "Ваш аккаунт заблокирован. Причина: " + (user.ban_reason || "не указана")
        });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
        return res.render("login", {
            title: "Вход",
            error: "Неверный логин или пароль"
        });
    }

    req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
    };

    res.redirect("/recipes");
});

// ------------------------
// Регистрация
// ------------------------
app.get("/register", (req, res) => {
    res.render("register", { title: "Регистрация" });
});

app.post("/register", async (req, res) => {
    const { login, name, email, password, password_confirm } = req.body;

    if (password !== password_confirm) {
        return res.render("register", {
            title: "Регистрация",
            errors: ["Пароли не совпадают"],
            login,
            name,
            email
        });
    }

    try {
        const [existing] = await db.query(
            "SELECT id FROM users WHERE email = ? OR login = ? LIMIT 1",
            [email, login]
        );

        if (existing.length) {
            return res.render("register", {
                title: "Регистрация",
                errors: ["Пользователь с таким email или логином уже существует"],
                login,
                name,
                email
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const [result] = await db.query(
            `INSERT INTO users (login, name, email, password, role)
             VALUES (?, ?, ?, ?, 'user')`,
            [login, name, email, hashedPassword]
        );

        req.session.user = {
            id: result.insertId,
            name,
            email,
            role: "user"
        };

        res.redirect("/recipes");

    } catch (err) {
        console.error(err);
        res.render("register", {
            title: "Регистрация",
            errors: ["Ошибка при регистрации"],
            login,
            name,
            email
        });
    }
});


// Выход
app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
});



// ------------------------------------------------------------------------
// Список рецептов
// ------------------------------------------------------------------------
app.get("/recipes", async (req, res) => {
    const { search, category } = req.query;

    // ВАРИАНТ 2: Более безопасный запрос
    let sqlQuery = `
        SELECT DISTINCT
            r.*, 
            u.name AS author_name,
            GROUP_CONCAT(DISTINCT cat.name) as category_names
        FROM recipes r
        LEFT JOIN users u ON r.user_id = u.id
        LEFT JOIN recipe_categories rc ON r.id = rc.recipe_id
        LEFT JOIN categories cat ON rc.category_id = cat.id AND cat.active = TRUE
        WHERE 1=1
    `;

    const params = [];

    if (search && search.trim()) {
        sqlQuery += ` AND r.title LIKE ?`;
        params.push(`%${search.trim()}%`);
    }

    if (category && category.trim()) {
        // Проверяем, что категория активна и существует
        sqlQuery += ` AND r.id IN (
            SELECT recipe_id FROM recipe_categories rc2
            JOIN categories c2 ON rc2.category_id = c2.id
            WHERE c2.id = ? AND c2.active = TRUE
        )`;
        params.push(category);
    }

    sqlQuery += ` GROUP BY r.id ORDER BY r.id DESC`;

    try {
        const [recipes] = await db.query(sqlQuery, params);
        
        // Для фильтра показываем только активные категории
        const [categories] = await db.query(
            "SELECT * FROM categories WHERE active = TRUE ORDER BY name ASC"
        );

        res.render("recipes", {
            title: "Рецепты",
            recipes: recipes.map(recipe => ({
                ...recipe,
                category_name: recipe.category_names ? recipe.category_names.split(',')[0] : null
            })),
            categories,
            user: req.session.user,
            search: search || '',
            category: category || ''
        });
    } catch (err) {
        console.error("Ошибка:", err);
        res.status(500).render("error", {
            title: "Ошибка фильтрации",
            message: "Не удалось выполнить фильтрацию рецептов"
        });
    }
});

// ------------------------------------------------------------------------
// Создание рецепта
// ------------------------------------------------------------------------
app.get("/recipes/create", requireAuth, async (req, res) => {
    // ИЗМЕНЕНИЕ: Добавляем WHERE active = TRUE
    const [categories] = await db.query("SELECT * FROM categories WHERE active = TRUE ORDER BY name ASC");

    res.render("create_recipe", {
        title: "Создать рецепт",
        categories
    });
});

app.post(
    "/recipes/create",
    requireAuth,
    dynamicUpload,
    async (req, res) => {

        const {
            title,
            description,
            cooking_time,
            ingredients_text,
            category_id,
            step_texts
        } = req.body;

        const recipeImage = req.files.image
            ? `/uploads/${req.files.image[0].filename}`
            : null;

        try {
            const [result] = await db.query(
                `INSERT INTO recipes 
                (user_id, title, description, cooking_time, image, ingredients_text)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    req.session.user.id,
                    title,
                    description || null,
                    cooking_time || null,
                    recipeImage,
                    ingredients_text
                ]
            );

            const recipeId = result.insertId;

            // категории
            if (category_id) {
                await db.query(
                    "INSERT INTO recipe_categories (recipe_id, category_id) VALUES (?, ?)",
                    [recipeId, category_id]
                );
            }

            // шаги + картинки
            if (step_texts) {
                const steps = Array.isArray(step_texts) ? step_texts : [step_texts];

                for (let i = 0; i < steps.length; i++) {
                    if (!steps[i].trim()) continue;

                    let imagePath = null;
                    const fileKey = `step_images_${i}`;
                    if (req.files[fileKey] && req.files[fileKey][0]) {
                        imagePath = `/uploads/${req.files[fileKey][0].filename}`;
                    }

                    await db.query(
                        `INSERT INTO recipe_steps (recipe_id, step_number, text, image)
                         VALUES (?, ?, ?, ?)`,
                        [recipeId, i + 1, steps[i], imagePath]
                    );
                }
            }

            // ⭐ СОЗДАНИЕ УВЕДОМЛЕНИЯ ДЛЯ АВТОРА
            await createNotification(
                req.session.user.id,
                `Вы создали новый рецепт: "${title}"`,
                `/recipes/${recipeId}`
            );

            res.redirect(`/recipes/${recipeId}`);

        } catch (err) {
            console.error(err);
            res.send("Ошибка при добавлении рецепта");
        }
    }
);

// ------------------------------------------------------------------------
// Просмотр рецепта
// ------------------------------------------------------------------------
app.get("/recipes/:id", async (req, res) => {
    const recipeId = req.params.id;
    const user = req.session.user || null;

    try {
        // Рецепт + автор
        const [[recipe]] = await db.query(
            `SELECT r.*, u.name AS author_name
             FROM recipes r
             LEFT JOIN users u ON r.user_id = u.id
             WHERE r.id = ?`,
            [recipeId]
        );

        if (!recipe) return res.status(404).send("Рецепт не найден");

        // Шаги
        const [steps] = await db.query(
            `SELECT step_number, text, image
             FROM recipe_steps
             WHERE recipe_id = ?
             ORDER BY step_number`,
            [recipeId]
        );

        // Категории
        const [categories] = await db.query(
            `SELECT c.name
             FROM recipe_categories rc
             JOIN categories c ON rc.category_id = c.id
             WHERE rc.recipe_id = ?`,
            [recipeId]
        );

        // Отзывы
        const [reviews] = await db.query(
            `SELECT r.*, u.name AS user_name
             FROM reviews r
             LEFT JOIN users u ON r.user_id = u.id
             WHERE r.recipe_id = ?
             ORDER BY r.created_at DESC`,
            [recipeId]
        );

        // Рейтинг
        const [[rating]] = await db.query(
            `SELECT 
                COUNT(*) AS count,
                ROUND(AVG(rating), 1) AS avg
             FROM ratings
             WHERE recipe_id = ?`,
            [recipeId]
        );

        // Ставил ли пользователь оценку
        let userRating = null;
        if (user) {
            const [[ur]] = await db.query(
                `SELECT rating FROM ratings
                 WHERE recipe_id = ? AND user_id = ?`,
                [recipeId, user.id]
            );
            userRating = ur?.rating || null;
        }

        const canEdit =
            user && (user.role === "admin" || user.id === recipe.user_id);

        res.render("recipe", {
            title: recipe.title,
            recipe,
            ingredientsText: recipe.ingredients_text,
            steps,
            categories,
            reviews,
            rating,
            userRating,
            canEdit,
            user
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Ошибка сервера");
    }
});


app.post("/recipes/:id/rating", async (req, res) => {
    const recipeId = req.params.id;
    const { rating } = req.body;
    const user = req.session.user;

    if (!user) {
        return res.status(403).send("Только для авторизованных");
    }

    // автор не может оценивать себя
    const [[recipe]] = await db.query(
        "SELECT user_id, title FROM recipes WHERE id = ?",
        [recipeId]
    );

    if (recipe.user_id === user.id) {
        return res.status(403).send("Нельзя оценивать свой рецепт");
    }

    try {
        await db.query(
            "INSERT INTO ratings (recipe_id, user_id, rating) VALUES (?, ?, ?)",
            [recipeId, user.id, rating]
        );
        
        // ⭐ СОЗДАНИЕ УВЕДОМЛЕНИЯ ДЛЯ АВТОРА РЕЦЕПТА
        await createNotification(
            recipe.user_id,
            `Пользователь ${user.name} оценил ваш рецепт "${recipe.title}" на ${rating} ⭐`,
            `/recipes/${recipeId}`
        );

    } catch (err) {
        // если уже ставил
        return res.status(400).send("Вы уже оценили этот рецепт");
    }

    res.redirect(`/recipes/${recipeId}`);
});



// ОБНОВЛЕННЫЙ МАРШРУТ ДЛЯ AJAX ОТЗЫВОВ
app.post("/recipes/:id/review", async (req, res) => {
    const recipeId = req.params.id;
    const { text, parent_id } = req.body;
    const user = req.session.user;

    try {
        // Получаем информацию о рецепте для уведомления
        const [[recipe]] = await db.query(
            "SELECT user_id, title FROM recipes WHERE id = ?",
            [recipeId]
        );

        const authorName = user ? null : req.body.author_name;
        const reviewerName = user ? user.name : authorName;

        // Вставляем отзыв
        const [result] = await db.query(
            `INSERT INTO reviews (recipe_id, user_id, author_name, text, parent_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
                recipeId,
                user ? user.id : null,
                authorName,
                text,
                parent_id || null
            ]
        );

        const reviewId = result.insertId;

        // Получаем данные нового отзыва
        const [[newReview]] = await db.query(
            `SELECT r.*, u.name as user_name 
             FROM reviews r
             LEFT JOIN users u ON r.user_id = u.id
             WHERE r.id = ?`,
            [reviewId]
        );

        // ⭐ СОЗДАНИЕ УВЕДОМЛЕНИЯ ДЛЯ АВТОРА РЕЦЕПТА (если отзыв не от автора)
        if (recipe.user_id !== (user ? user.id : null)) {
            await createNotification(
                recipe.user_id,
                `Пользователь ${reviewerName} оставил отзыв на ваш рецепт "${recipe.title}"`,
                `/recipes/${recipeId}`
            );
        }

        // Отправляем JSON вместо редиректа
        res.json({
            success: true,
            review: {
                id: newReview.id,
                text: newReview.text,
                created_at: newReview.created_at,
                user_name: newReview.user_name || newReview.author_name || 'Аноним'
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            error: "Ошибка при добавлении отзыва"
        });
    }
});


// ------------------------------------------------------------------------
// Редактирование рецепта — УПРОЩЕННАЯ ВЕРСИЯ
// ------------------------------------------------------------------------
app.get("/recipes/:id/edit", requireOwnerOrAdmin, async (req, res) => {
    const recipeId = req.params.id;

    const [[recipe]] = await db.query(
        "SELECT * FROM recipes WHERE id = ?",
        [recipeId]
    );
    if (!recipe) return res.send("Рецепт не найден");

    // ИЗМЕНЕНИЕ: Добавляем WHERE active = TRUE
    const [categories] = await db.query("SELECT * FROM categories WHERE active = TRUE ORDER BY name ASC");

    const [selectedCats] = await db.query(
        "SELECT category_id FROM recipe_categories WHERE recipe_id = ?",
        [recipeId]
    );
    const selectedCategory = selectedCats.length > 0 ? selectedCats[0].category_id : null;

    const [steps] = await db.query(
        `SELECT id, step_number, text, image 
         FROM recipe_steps 
         WHERE recipe_id = ? 
         ORDER BY step_number ASC`,
        [recipeId]
    );

    res.render("edit_recipe", {
        title: "Редактировать рецепт",
        recipe,
        categories,
        selectedCategory,
        steps
    });
});

app.post("/recipes/:id/edit", 
    requireOwnerOrAdmin, 
    dynamicUpload,
    async (req, res) => {

    const recipeId = req.params.id;
    const { 
        title, 
        description, 
        cooking_time, 
        ingredients_text, 
        category_id, 
        step_texts,
        step_ids
    } = req.body;

    // Обработка обложки
    let imagePath = null;
    if (req.files.image) {
        imagePath = `/uploads/${req.files.image[0].filename}`;
    } else {
        imagePath = undefined;
    }

    try {
        // Обновление рецепта
        let updateQuery = `UPDATE recipes SET title=?, description=?, cooking_time=?, ingredients_text=?`;
        const params = [title, description, cooking_time, ingredients_text];
        
        if (imagePath !== undefined) {
            updateQuery += `, image=?`;
            params.push(imagePath);
        }
        
        updateQuery += ` WHERE id=?`;
        params.push(recipeId);
        
        await db.query(updateQuery, params);

        // Категории
        await db.query("DELETE FROM recipe_categories WHERE recipe_id=?", [recipeId]);
        if (category_id) {
            await db.query(
                "INSERT INTO recipe_categories (recipe_id, category_id) VALUES (?,?)",
                [recipeId, category_id]
            );
        }

        // Шаги - ИСПРАВЛЕННАЯ ЛОГИКА
        if (step_texts) {
            const steps = Array.isArray(step_texts) ? step_texts : [step_texts];
            
            for (let i = 0; i < steps.length; i++) {
                if (!steps[i].trim()) continue;
                
                let stepImage = null;
                
                // Получаем файл для текущего шага по индексу
                const fileKey = `step_images_${i}`;
                if (req.files[fileKey] && req.files[fileKey][0]) {
                    stepImage = `/uploads/${req.files[fileKey][0].filename}`;
                } 
                // Если файла нет, но есть ID шага - проверяем старое изображение
                else if (step_ids && step_ids[i]) {
                    const [[oldStep]] = await db.query(
                        "SELECT image FROM recipe_steps WHERE id = ? AND recipe_id = ?",
                        [step_ids[i], recipeId]
                    );
                    if (oldStep && oldStep.image) {
                        stepImage = oldStep.image;
                    }
                }
                
                // Обновляем или создаем шаг
                if (step_ids && step_ids[i]) {
                    // Обновляем существующий шаг
                    await db.query(
                        "UPDATE recipe_steps SET step_number = ?, text = ?, image = ? WHERE id = ? AND recipe_id = ?",
                        [i + 1, steps[i], stepImage, step_ids[i], recipeId]
                    );
                } else {
                    // Создаем новый шаг
                    await db.query(
                        "INSERT INTO recipe_steps (recipe_id, step_number, text, image) VALUES (?,?,?,?)",
                        [recipeId, i + 1, steps[i], stepImage]
                    );
                }
            }
            
            // Удаляем шаги, которых больше нет
            const totalSteps = steps.length;
            await db.query(
                "DELETE FROM recipe_steps WHERE recipe_id = ? AND step_number > ?",
                [recipeId, totalSteps]
            );
        }

        res.redirect(`/recipes/${recipeId}`);
    } catch (err) {
        console.error(err);
        res.send("Ошибка при редактировании рецепта");
    }
});

// ------------------------------------------------------------------------
// Удаление рецепта — новый правильный маршрут
// ------------------------------------------------------------------------
app.get("/recipes/:id/delete", requireOwnerOrAdmin, async (req, res) => {
    const id = req.params.id;

    await db.query("DELETE FROM recipe_steps WHERE recipe_id=?", [id]);
    await db.query("DELETE FROM recipe_categories WHERE recipe_id=?", [id]);
    await db.query("DELETE FROM recipes WHERE id=?", [id]);

    res.redirect("/recipes");
});

// -------------------------------------------------------------
// МАРШРУТЫ ДЛЯ УВЕДОМЛЕНИЙ
// -------------------------------------------------------------

// Страница всех уведомлений
app.get("/notifications", requireAuth, async (req, res) => {
    try {
        const notifications = await getUserNotifications(req.session.user.id, 50);
        
        res.render("notifications", {
            title: "Уведомления",
            notifications,
            notificationCount: 0 // На этой странице все уведомления считаются прочитанными
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Ошибка при загрузке уведомлений");
    }
});

app.post("/notifications/:id/read", requireAuth, async (req, res) => {
    const notificationId = req.params.id;
    
    await markAsRead(notificationId, req.session.user.id);
    
    res.json({ success: true });
});

app.post("/notifications/read-all", requireAuth, async (req, res) => {
    await markAllAsRead(req.session.user.id);
    
    res.json({ success: true });
});

// API для получения количества уведомлений
app.get("/api/notifications/count", requireAuth, async (req, res) => {
    const count = await getUnreadCount(req.session.user.id);
    res.json({ count });
});
// ------------------------------------------------------------------------
// Админка пользователей
// ------------------------------------------------------------------------
app.get("/admin/users", requireAdmin, async (req, res) => {
    try {
        const [users] = await db.query(`
            SELECT *, 
                   DATE_FORMAT(banned_at, '%d.%m.%Y %H:%i') as banned_at_formatted
            FROM users 
            ORDER BY 
                CASE WHEN id = ? THEN 0 ELSE 1 END,
                is_banned DESC,
                id ASC
        `, [req.session.user.id]);
        
        res.render("admin_users", {
            title: "Управление пользователями",
            users,
            user: req.session.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Ошибка сервера");
    }
});

// ------------------------------------------------------------------------
// Админка словарей (категории)
// ------------------------------------------------------------------------
app.get("/admin/dicts", requireAdmin, async (req, res) => {
    try {
        // ИЗМЕНЕНИЕ: Убираем WHERE active = TRUE для админки
        const [categories] = await db.query("SELECT * FROM categories ORDER BY id DESC");

        res.render("admin_dicts", {
            user: req.session.user,
            categories
        });

    } catch (err) {
        console.log(err);
        res.send("Ошибка загрузки справочников");
    }
});

// Добавление категории
// Добавление категории
app.post("/admin/dicts/category/add", requireAdmin, async (req, res) => {
    const { name } = req.body;

    if (!name || name.trim() === "") {
        return res.send("Название категории не может быть пустым");
    }

    await db.query("INSERT INTO categories (name, active) VALUES (?, TRUE)", [name.trim()]);
    res.redirect("/admin/dicts");
});

// Удаление категории
app.get("/admin/dicts/category/delete/:id", requireAdmin, async (req, res) => {
    const categoryId = req.params.id; // Получаем ID из URL
    
    try {
        // Проверяем, используется ли категория в рецептах
        const [usedInRecipes] = await db.query(
            "SELECT COUNT(*) as count FROM recipe_categories WHERE category_id = ?",
            [categoryId]
        );
        
        if (usedInRecipes[0].count > 0) {
            // Категория используется, не удаляем, а деактивируем
            await db.query("UPDATE categories SET active = FALSE WHERE id = ?", [categoryId]);
            
            const [categories] = await db.query("SELECT * FROM categories ORDER BY id DESC");
            return res.render("admin_dicts", {
                user: req.session.user,
                categories,
                message: "Категория деактивирована (используется в рецептах)"
            });
        }
        
        // Категория не используется - удаляем полностью
        await db.query("DELETE FROM categories WHERE id = ?", [categoryId]);
        
        // Получаем обновленный список категорий
        const [categories] = await db.query("SELECT * FROM categories ORDER BY id DESC");
        
        res.render("admin_dicts", {
            user: req.session.user,
            categories,
            message: "Категория успешно удалена!"
        });

    } catch (err) {
        console.error(err);
        const [categories] = await db.query("SELECT * FROM categories ORDER BY id DESC");
        res.render("admin_dicts", {
            user: req.session.user,
            categories,
            error: "Ошибка при удалении категории"
        });
    }
});


// Бан пользователя
app.post("/admin/users/ban/:id", requireAdmin, async (req, res) => {
    const userId = req.params.id;
    const { ban_reason } = req.body;

    // Запрещаем банить себя
    if (req.session.user.id == userId) {
        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        return res.render("admin_users", {
            title: "Пользователи",
            users,
            error: "Нельзя забанить свой собственный аккаунт!"
        });
    }

    try {
        // Баним пользователя
        await db.query(
            "UPDATE users SET is_banned = TRUE, ban_reason = ?, banned_at = NOW() WHERE id = ?",
            [ban_reason || "Без указания причины", userId]
        );

        // Делаем рецепты забаненного пользователя анонимными
        await db.query(
            "UPDATE recipes SET user_id = NULL WHERE user_id = ?",
            [userId]
        );

        // Удаляем оценки забаненного пользователя
        await db.query(
            "DELETE FROM ratings WHERE user_id = ?",
            [userId]
        );

        // Делаем отзывы анонимными
        await db.query(
            "UPDATE reviews SET user_id = NULL WHERE user_id = ?",
            [userId]
        );

        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin_users", {
            title: "Пользователи",
            users,
            message: `Пользователь забанен. Его рецепты сохранены как анонимные.`
        });

    } catch (err) {
        console.error("Ошибка при бане пользователя:", err);
        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin_users", {
            title: "Пользователи",
            users,
            error: "Ошибка при бане пользователя: " + err.message
        });
    }
});

// Разбан пользователя
app.post("/admin/users/unban/:id", requireAdmin, async (req, res) => {
    const userId = req.params.id;

    try {
        await db.query(
            "UPDATE users SET is_banned = FALSE, ban_reason = NULL, banned_at = NULL WHERE id = ?",
            [userId]
        );

        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin_users", {
            title: "Пользователи",
            users,
            message: "Пользователь разбанен."
        });

    } catch (err) {
        console.error("Ошибка при разбане пользователя:", err);
        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin_users", {
            title: "Пользователи",
            users,
            error: "Ошибка при разбане пользователя"
        });
    }
});

app.post("/admin/users/delete/:id", requireAdmin, async (req, res) => {
    const userId = req.params.id;

    // Нельзя удалить себя
    if (req.session.user.id == userId) {
        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        return res.render("admin_users", {
            title: "Пользователи",
            users,
            error: "Нельзя удалить свой собственный аккаунт!"
        });
    }

    try {
        // Начинаем транзакцию
        await db.query("START TRANSACTION");

        // Получаем информацию о пользователе для лога
        const [[user]] = await db.query("SELECT login FROM users WHERE id = ?", [userId]);

        // 1. Удаляем рецепты пользователя и связанные данные
        const [userRecipes] = await db.query("SELECT id FROM recipes WHERE user_id = ?", [userId]);
        
        for (const recipe of userRecipes) {
            // Удаляем шаги рецептов
            await db.query("DELETE FROM recipe_steps WHERE recipe_id = ?", [recipe.id]);
            // Удаляем категории рецептов
            await db.query("DELETE FROM recipe_categories WHERE recipe_id = ?", [recipe.id]);
            // Удаляем оценки рецептов
            await db.query("DELETE FROM ratings WHERE recipe_id = ?", [recipe.id]);
            // Удаляем отзывы к рецептам
            await db.query("DELETE FROM reviews WHERE recipe_id = ?", [recipe.id]);
        }
        
        // Удаляем сами рецепты
        await db.query("DELETE FROM recipes WHERE user_id = ?", [userId]);

        // 2. Удаляем оценки, которые поставил пользователь
        await db.query("DELETE FROM ratings WHERE user_id = ?", [userId]);

        // 3. Удаляем отзывы пользователя
        await db.query("DELETE FROM reviews WHERE user_id = ?", [userId]);

        // 4. Удаляем уведомления пользователя
        await db.query("DELETE FROM notifications WHERE user_id = ?", [userId]);

        // 5. Удаляем самого пользователя
        await db.query("DELETE FROM users WHERE id = ?", [userId]);

        // Фиксируем транзакцию
        await db.query("COMMIT");

        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin_users", {
            title: "Пользователи",
            users,
            message: `Пользователь ${user.login} и все его данные удалены!`
        });

    } catch (err) {
        // Откатываем транзакцию при ошибке
        await db.query("ROLLBACK");
        console.error(err);
        
        const [users] = await db.query("SELECT * FROM users ORDER BY id ASC");
        res.render("admin_users", {
            title: "Пользователи",
            users,
            error: "Ошибка при удалении пользователя"
        });
    }
});

// ---------------------------------------------------------------------------------------------------
// Запуск сервера
// ---------------------------------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});
