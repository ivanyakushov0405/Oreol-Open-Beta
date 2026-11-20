# Деплой new.halomvp.ru рядом со старым сайтом

Старый сайт на `halomvp.ru` остаётся как есть. Старый LiveKit занимает 7880–7882 (7881/tcp, 7882/udp),
новый берёт 7890 и 7981/7982 — они не пересекаются. Новая версия живёт на `new.halomvp.ru`
со своим бэкендом, своей базой и своим LiveKit. Порты не пересекаются со старыми:

| Что                     | Порт            | Наружу?                    |
|-------------------------|-----------------|----------------------------|
| FastAPI (новый бэкенд)  | 127.0.0.1:8100  | нет, через nginx           |
| LiveKit сигнал/API      | 127.0.0.1:7890  | нет, через nginx `/rtc`    |
| LiveKit медиа TCP       | 7981/tcp        | **да, открыть в фаерволе** |
| LiveKit медиа UDP       | 7982/udp        | **да, открыть в фаерволе** |

## 0. DNS
В панели регистратора добавить A-запись: `new` → `194.61.9.72`.
(`chat.` и `rtc.` в DNS сейчас нет, поэтому их блоки в старом nginx никто не использует.)

## 1. Код на сервер
```bash
sudo mkdir -p /opt/oreol-new && sudo chown $USER /opt/oreol-new
# с компьютера: скопировать проект без node_modules/dist/.env/*.db
rsync -av --exclude node_modules --exclude dist --exclude '.env' --exclude '*.db' ./ user@194.61.9.72:/opt/oreol-new/
```

## 2. Настройки
```bash
cd /opt/oreol-new/deploy
cp .env.example .env
nano .env        # LK_API_KEY, LK_API_SECRET (новые!), PUBLIC_IP
```

## 3. Проверить, что порты свободны
```bash
sudo ss -ltnup | grep -E ':(8100|7890|7981|7982)\b' || echo "свободно"
# если что-то занято — поменять номер в livekit.yaml (rtc.tcp_port / rtc.udp_port) и в фаерволе
```

## 4. Запуск
Контейнеры называются `oreol-new-app` и `oreol-new-livekit` (проект `oreol-new`),
поэтому старые контейнеры не пересоздаются и не останавливаются. Посмотреть, что уже крутится:
```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```
```bash
docker compose up -d --build
curl -s http://127.0.0.1:8100/ | head -c 100     # должна прийти HTML-страница
curl -s http://127.0.0.1:7890/                   # LiveKit отвечает "OK"
```

## 5. nginx (старые конфиги не трогаем)
```bash
sudo cp new.halomvp.ru.conf /etc/nginx/sites-available/new.halomvp.ru
sudo cp oreol-new-proxy.conf /etc/nginx/snippets/oreol-new-proxy.conf
sudo ln -s /etc/nginx/sites-available/new.halomvp.ru /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d new.halomvp.ru          # https + редирект
```

## 6. Фаервол
```bash
sudo ufw allow 7981/tcp
sudo ufw allow 7982/udp
```
(и то же самое в панели хостинга, если там свой фаервол)

## Обновление
```bash
cd /opt/oreol-new && git pull   # или снова rsync
cd deploy && docker compose up -d --build
```

## Пароль как на старом сайте (необязательно)
Старый `halomvp.ru` закрыт basic-auth. Чтобы закрыть и новый, добавить в оба `location`
`auth_basic "Oreol"; auth_basic_user_file /etc/nginx/.htpasswd;` — кроме `/rtc`
(LiveKit-клиент не умеет basic-auth; он и так защищён токеном).
