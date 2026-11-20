# Развёртывание на VPS

Подготовь Linux VPS с публичным IPv4, двумя DNS-именами, Docker Engine с Compose v2, Python 3 и доступом к `sudo`. Ниже команды для Ubuntu или Debian. Нужен доступ к реестрам образов и Python-пакетов, а браузерам нужен доступ к CDN jsDelivr для голосового клиента.

## 1. DNS, порты и ключи

Создай две записи `A`, указывающие на публичный IPv4 VPS. В примере `chat.example.com` открывает приложение, а `rtc.example.com` обслуживает LiveKit. Если DNS-провайдер предлагает проксирование, используй режим DNS only. Для этого IPv4-сценария оставь только записи `A`.

Открой входящие порты в файрволе VPS и в панели провайдера.

| Порт | Назначение |
| --- | --- |
| `80/tcp` | Проверка доменов Let's Encrypt и перенаправление на HTTPS |
| `443/tcp` | HTTPS и WebSocket для обоих доменов |
| `7881/tcp` | Резервный транспорт WebRTC |
| `7882/udp` | Основной голосовой трафик WebRTC |

Сохрани действующее правило для SSH. Порты `8000` и `7880` слушают только loopback. LiveKit сообщает клиентам IPv4 из `LIVEKIT_NODE_IP`. Если у VPS внешний NAT, медиапорты должны доходить до VPS. TURN в этой конфигурации отсутствует. Сети, блокирующие оба медиапорта, могут пропускать текст и блокировать голос. [Порты LiveKit](https://docs.livekit.io/transport/self-hosting/ports-firewall/)

Из корня проекта сгенерируй `.env` по [инструкции](../README.md#генерация-ключей-livekit). В нём укажи `LK_SERVER_URL=wss://rtc.example.com` со своим доменом и `LIVEKIT_NODE_IP` с публичным IPv4 сервера. `LK_API_URL` можно оставить пустой, чтобы приложение обращалось к LiveKit через loopback.

## 2. Nginx и сертификат

В следующих командах замени оба домена на свои. Выполняй команды из корня проекта в одной сессии оболочки.

```bash
CHAT_DOMAIN=chat.example.com
LIVEKIT_DOMAIN=rtc.example.com

sudo apt update
sudo apt install nginx certbot apache2-utils
sudo install -d -m 0755 /var/www/oreol-acme

sed -e "s/chat\.example\.com/$CHAT_DOMAIN/g" -e "s/rtc\.example\.com/$LIVEKIT_DOMAIN/g" \
  deploy/nginx-http.conf | sudo tee /etc/nginx/conf.d/oreol-http.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/oreol-acme --cert-name oreol-demo \
  -d "$CHAT_DOMAIN" -d "$LIVEKIT_DOMAIN" --deploy-hook 'systemctl reload nginx'

sudo htpasswd -cB /etc/nginx/oreol.htpasswd demo
sudo chown root:www-data /etc/nginx/oreol.htpasswd
sudo chmod 0640 /etc/nginx/oreol.htpasswd

sed -e "s/chat\.example\.com/$CHAT_DOMAIN/g" -e "s/rtc\.example\.com/$LIVEKIT_DOMAIN/g" \
  deploy/nginx-https.conf | sudo tee /etc/nginx/conf.d/oreol-https.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

Используй `htpasswd -cB` при первом создании файла. Для добавления или обновления пользователя используй `sudo htpasswd -B /etc/nginx/oreol.htpasswd имя`. Оставь HTTP-конфиг для продления сертификата. Проверь продление командой `sudo certbot renew --dry-run`. [Certbot Webroot](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot) · [Nginx WebSocket](https://nginx.org/en/docs/http/websocket.html)

## 3. Запуск

```bash
docker compose -p oreol-vps -f docker-compose.internet.yml config --quiet
docker compose -p oreol-vps -f docker-compose.internet.yml up --build -d
docker compose -p oreol-vps -f docker-compose.internet.yml ps
```

Открой HTTPS-адрес чата и введи логин и пароль из `htpasswd`. Зайди с двух устройств под разными именами в приложении, отправь сообщение и проверь звук в Lounge. Если голос не соединяется, проверь DNS для LiveKit, публичный IPv4 и оба медиапорта.

Для остановки используй `docker compose -p oreol-vps -f docker-compose.internet.yml down`. История остаётся в Docker-томе `chat-data`. Пароль Nginx ограничивает вход в демо. Внутри демо все допущенные пользователи могут читать и очищать историю, а отображаемые имена выбирают сами.
