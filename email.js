import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

// Создание транспорта для отправки почты
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false, // true для 465, false для других портов
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// Проверка подключения к почте
export async function verifyEmailConnection() {
    try {
        await transporter.verify();
        console.log('✅ Email server подключен');
        return true;
    } catch (error) {
        console.error('❌ Ошибка подключения к email:', error);
        return false;
    }
}

// Шаблон email-уведомления
const emailTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #ff7043 0%, #ff5722 100%); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #eee; }
        .footer { text-align: center; margin-top: 20px; color: #777; font-size: 12px; }
        .button { display: inline-block; padding: 12px 24px; background: #ff7043; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        .notification-item { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #ff7043; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>🍳 Кулинарный сайт</h2>
        </div>
        <div class="content">
            ${content}
            <div class="footer">
                <p>Вы получили это письмо, потому что подписаны на уведомления на нашем сайте.</p>
                <p><a href="${process.env.SITE_URL || 'http://localhost:3000'}/profile/notifications">Настроить уведомления</a></p>
            </div>
        </div>
    </div>
</body>
</html>
`;

// Отправка email-уведомления
export async function sendEmailNotification(to, subject, content, isHtml = true) {
    try {
        if (!to || !subject || !content) {
            console.error('❌ Не указаны параметры для отправки email');
            return false;
        }

        const mailOptions = {
            from: `"Кулинарный сайт" <${process.env.EMAIL_FROM}>`,
            to,
            subject,
            text: !isHtml ? content : content.replace(/<[^>]*>/g, ''),
            html: isHtml ? emailTemplate(content) : undefined
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email отправлен: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error('❌ Ошибка отправки email:', error);
        return false;
    }
}

// Типы email-уведомлений
export const EmailTypes = {
    NEW_RATING: 'NEW_RATING',           // Новая оценка рецепта
    NEW_REVIEW: 'NEW_REVIEW',           // Новый отзыв
    ADMIN_BAN: 'ADMIN_BAN',             // Бан от администратора
    ADMIN_UNBAN: 'ADMIN_UNBAN',         // Разбан от администратора
    ADMIN_ACTION: 'ADMIN_ACTION',       // Другие действия администратора
    RECIPE_UPDATED: 'RECIPE_UPDATED',   // Обновление рецепта
    WELCOME: 'WELCOME'                  // Приветственное письмо
};

// Генерация контента для разных типов уведомлений
export function generateEmailContent(type, data) {
    switch (type) {
        case EmailTypes.NEW_RATING:
            return `
                <div class="notification-item">
                    <h3>⭐ Новая оценка вашего рецепта!</h3>
                    <p>Пользователь <strong>${data.userName}</strong> оценил ваш рецепт 
                    <strong>"${data.recipeTitle}"</strong> на <strong>${data.rating} из 5</strong> ⭐</p>
                    <p><a href="${data.link}" class="button">Посмотреть рецепт</a></p>
                </div>
            `;
        
        case EmailTypes.NEW_REVIEW:
            return `
                <div class="notification-item">
                    <h3>💬 Новый отзыв на ваш рецепт!</h3>
                    <p>Пользователь <strong>${data.userName}</strong> оставил отзыв на ваш рецепт 
                    <strong>"${data.recipeTitle}"</strong>:</p>
                    <blockquote style="background: #f0f0f0; padding: 10px; border-left: 3px solid #ff7043; margin: 15px 0;">
                        "${data.reviewText}"
                    </blockquote>
                    <p><a href="${data.link}" class="button">Посмотреть все отзывы</a></p>
                </div>
            `;
        
        case EmailTypes.ADMIN_BAN:
            return `
                <div class="notification-item">
                    <h3>🚫 Ваш аккаунт был заблокирован</h3>
                    <p>Администратор сайта заблокировал ваш аккаунт.</p>
                    <p><strong>Причина:</strong> ${data.reason || 'Не указана'}</p>
                    <p><strong>Дата блокировки:</strong> ${new Date().toLocaleDateString('ru-RU')}</p>
                    <p>Если вы считаете, что это ошибка, свяжитесь с администрацией сайта.</p>
                </div>
            `;
        
        case EmailTypes.ADMIN_UNBAN:
            return `
                <div class="notification-item">
                    <h3>✅ Ваш аккаунт разблокирован</h3>
                    <p>Администратор сайта снял блокировку с вашего аккуанта.</p>
                    <p>Теперь вы снова можете пользоваться всеми функциями сайта.</p>
                    <p><a href="${process.env.SITE_URL || 'http://localhost:3000'}" class="button">Вернуться на сайт</a></p>
                </div>
            `;
        
        case EmailTypes.WELCOME:
            return `
                <div class="notification-item">
                    <h3>👋 Добро пожаловать на Кулинарный сайт!</h3>
                    <p>Спасибо за регистрацию, <strong>${data.userName}</strong>!</p>
                    <p>Теперь вы можете:</p>
                    <ul>
                        <li>Создавать собственные рецепты</li>
                        <li>Оценивать и комментировать рецепты других пользователей</li>
                        <li>Сохранять понравившиеся рецепты</li>
                    </ul>
                    <p><a href="${process.env.SITE_URL || 'http://localhost:3000'}/recipes/create" class="button">Создать первый рецепт</a></p>
                </div>
            `;
        
        default:
            return `
                <div class="notification-item">
                    <h3>🔔 Новое уведомление</h3>
                    <p>${data.message || 'У вас новое уведомление на сайте.'}</p>
                    ${data.link ? `<p><a href="${data.link}" class="button">Подробнее</a></p>` : ''}
                </div>
            `;
    }
}

// Основная функция отправки уведомлений (и в системе, и по email)
export async function sendNotification(userId, type, data, sendEmail = true) {
    try {
        // 1. Получаем email пользователя из базы данных
        const [[user]] = await db.query(
            "SELECT email, name FROM users WHERE id = ?",
            [userId]
        );
        
        if (!user) {
            console.error(`❌ Пользователь с ID ${userId} не найден`);
            return false;
        }
        
        // 2. Создаем уведомление в системе (в таблице notifications)
        let notificationText = '';
        let notificationLink = data.link || null;
        
        // Генерируем текст для системного уведомления
        switch (type) {
            case EmailTypes.NEW_RATING:
                notificationText = `Пользователь ${data.userName} оценил ваш рецепт "${data.recipeTitle}" на ${data.rating} ⭐`;
                break;
            case EmailTypes.NEW_REVIEW:
                notificationText = `Пользователь ${data.userName} оставил отзыв на ваш рецепт "${data.recipeTitle}"`;
                break;
            case EmailTypes.ADMIN_BAN:
                notificationText = `Ваш аккаунт заблокирован администратором. Причина: ${data.reason || 'не указана'}`;
                break;
            case EmailTypes.ADMIN_UNBAN:
                notificationText = `Ваш аккаунт разблокирован администратором`;
                break;
            default:
                notificationText = data.message || 'Новое уведомление';
        }
        
        // Сохраняем в БД
        await db.query(
            "INSERT INTO notifications (user_id, text, link) VALUES (?, ?, ?)",
            [userId, notificationText, notificationLink]
        );
        
        // 3. Отправляем email-уведомление (если нужно и если у пользователя есть email)
        if (sendEmail && user.email) {
            const emailContent = generateEmailContent(type, data);
            const subject = getEmailSubject(type);
            
            const emailSent = await sendEmailNotification(
                user.email,
                subject,
                emailContent
            );
            
            if (emailSent) {
                console.log(`✅ Уведомление отправлено пользователю ${userId} (${user.email})`);
            }
        }
        
        return true;
    } catch (error) {
        console.error('❌ Ошибка при отправке уведомления:', error);
        return false;
    }
}

// Получение темы письма
function getEmailSubject(type) {
    switch (type) {
        case EmailTypes.NEW_RATING: return '⭐ Новая оценка вашего рецепта';
        case EmailTypes.NEW_REVIEW: return '💬 Новый отзыв на ваш рецепт';
        case EmailTypes.ADMIN_BAN: return '🚫 Ваш аккаунт заблокирован';
        case EmailTypes.ADMIN_UNBAN: return '✅ Ваш аккаунт разблокирован';
        case EmailTypes.WELCOME: return '👋 Добро пожаловать на Кулинарный сайт!';
        default: return '🔔 Новое уведомление с Кулинарного сайта';
    }
}

// Экспортируем подключение к базе данных
let db;
export function setDatabaseConnection(database) {
    db = database;
}