# Deploy em produção

Guia para colocar o Uptrue num servidor Linux com HTTPS, backup diário e deploy automático
pelo GitHub Actions. Testado numa VM Ubuntu 24.04 (Oracle Cloud Always Free, 1 GB de RAM).

| Etapa | Resultado |
| --- | --- |
| 1. Endurecimento | atualizações automáticas, swap, SSH só por chave, fail2ban, firewall |
| 2. Docker | com limite de tamanho dos logs |
| 3. Uptrue | versão fixa, porta só interna |
| 4. Traefik | HTTPS automático (Let's Encrypt) e HSTS |
| 5. Backup | diário, testado, com rotação |
| 6. Deploy automático | tag publicada → testes → imagem → servidor atualizado, com rollback |

## 1. Endurecimento

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades fail2ban && sudo dpkg-reconfigure -plow unattended-upgrades

# swap (essencial com 1 GB de RAM)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf

# SSH: sem root, sem senha (teste numa segunda sessão antes de fechar a atual)
sudo tee /etc/ssh/sshd_config.d/99-endurecimento.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
EOF
sudo sshd -t && sudo systemctl reload ssh

# fail2ban: 5 erros em 10 min = 1 h bloqueado
printf '[sshd]\nenabled = true\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' | sudo tee /etc/fail2ban/jail.local
sudo systemctl enable --now fail2ban
```

**Oracle Cloud:** o Ubuntu da Oracle já vem com iptables bloqueando tudo menos a 22 (não use
`ufw` junto). Portas novas precisam ser liberadas **no iptables e na Security List** do painel.

## 2. Docker

Instale pelo [repositório oficial](https://docs.docker.com/engine/install/ubuntu/) e limite os logs:

```bash
echo '{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker && sudo usermod -aG docker "$USER"
```

> Portas publicadas pelo Docker **passam por fora** das regras de entrada do iptables. Publique
> portas internas só em `127.0.0.1`; quem atende a internet é o Traefik.

## 3. Uptrue

```bash
sudo mkdir -p /opt/uptrue && sudo chown "$USER": /opt/uptrue && cd /opt/uptrue
V=0.1.7   # a versão desejada
for f in compose.yml .env.example; do curl -fsSLO "https://raw.githubusercontent.com/gusmcardoso/uptrue/v$V/$f"; done
for s in update.sh backup.sh deploy-entry.sh; do curl -fsSL "https://raw.githubusercontent.com/gusmcardoso/uptrue/v$V/scripts/$s" -o "$s"; done
chmod 700 ./*.sh
cp .env.example .env && chmod 600 .env
sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -hex 32)|" .env
printf '\nUPTRUE_TAG=%s\nUPTRUE_PORT=127.0.0.1:3000\n' "$V" >> .env
docker compose pull && docker compose up -d --no-build
```

Sem HTTPS ainda, acesse o painel por túnel SSH (no seu computador):
`ssh -N -L 3100:127.0.0.1:3000 usuario@servidor` → <http://localhost:3100>.

## 4. Traefik (HTTPS)

1. Libere 80 e 443: `sudo iptables -I INPUT 5 -p tcp -m state --state NEW -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save` (e na Security List, na Oracle).
2. `docker network create proxy` e suba o Traefik em `/opt/traefik` com provider Docker
   (`exposedbydefault=false`), redirecionamento 80→443 e resolvedor ACME por HTTP-01.
3. Em `/opt/uptrue`, um `compose.override.yml` (o `compose.yml` do repositório fica intocado):

```yaml
services:
  uptrue:
    networks: [default, proxy]
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.uptrue.rule=Host(`${UPTRUE_DOMAIN}`)
      - traefik.http.routers.uptrue.entrypoints=websecure
      - traefik.http.routers.uptrue.tls.certresolver=le
      - traefik.http.routers.uptrue.middlewares=uptrue-hsts
      - traefik.http.middlewares.uptrue-hsts.headers.stsSeconds=31536000
      - traefik.http.services.uptrue.loadbalancer.server.port=3000
networks:
  proxy:
    external: true
```

Sem domínio, use [sslip.io](https://sslip.io): `203-0-113-10.sslip.io` resolve para `203.0.113.10`.

## 5. Backup

```bash
sudo mkdir -p /opt/backups && sudo chown "$USER": /opt/backups && chmod 700 /opt/backups
/opt/uptrue/backup.sh      # cópia consistente (VACUUM INTO) + integridade conferida + gzip + 14 dias
(crontab -l 2>/dev/null; echo "30 3 * * * /opt/uptrue/backup.sh >> /opt/backups/backup.log 2>&1") | crontab -
```

### Restaurar

```bash
cd /opt/uptrue
./restore.sh --list        # backups disponíveis
./restore.sh --latest      # ou ./restore.sh uptrue-AAAA-MM-DD_....db.gz
```

Confere o gzip e a integridade antes, salva o estado atual (dá para desfazer), troca o banco
removendo os arquivos WAL antigos, devolve o dono certo ao arquivo e confere saúde e número de sites.

### Cópia externa criptografada (Object Storage da Oracle, 20 GB grátis)

Um backup que fica na mesma máquina não protege contra perder a máquina. O `offsite-backup.sh`
envia o backup mais recente por rclone, **criptografado antes de sair do servidor** (conteúdo e nomes).

1. **No painel da Oracle:** *Storage → Buckets → Create bucket* (`uptrue-backups`, privado). Anote o
   **Namespace** (na página do bucket). Em *Perfil → Customer secret keys → Generate*, guarde o
   *Access key* e o *Secret* (o secret aparece uma vez só).
2. **No servidor**, crie a configuração do rclone (troque NAMESPACE, ACCESS e SECRET):

   ```bash
   cd /opt/uptrue && mkdir -p rclone && chmod 700 rclone
   rc() { docker run --rm -it --user "$(id -u):$(id -g)" -e RCLONE_CONFIG=/config/rclone.conf -v "$PWD/rclone:/config" rclone/rclone:1.69.1 "$@"; }
   rc config create oci s3 provider=Other access_key_id=ACCESS secret_access_key=SECRET      endpoint=https://NAMESPACE.compat.objectstorage.sa-saopaulo-1.oraclecloud.com region=sa-saopaulo-1 force_path_style=true
   SENHA=$(openssl rand -base64 32); echo "SENHA DO CRYPT (guarde no gerenciador de senhas): $SENHA"
   rc config create offsite crypt remote=oci:uptrue-backups password="$SENHA" --obscure
   chmod 600 rclone/rclone.conf
   ```

   **Guarde a senha do crypt fora do servidor** (gerenciador de senhas): sem ela, os backups
   externos não podem ser lidos, e é justamente quando o servidor se perde que você vai precisar dela.
3. Teste e agende junto com o backup local:

   ```bash
   ./offsite-backup.sh && ./offsite-backup.sh --list
   (crontab -l | grep -v backup.sh; echo "30 3 * * * { /opt/uptrue/backup.sh && /opt/uptrue/offsite-backup.sh; } >> /opt/backups/backup.log 2>&1") | crontab -
   ```

Para recuperar de fora: `./offsite-backup.sh --fetch NOME` e depois `./restore.sh NOME`.

## 6. Atualização e deploy automático

`/opt/uptrue/update.sh [versão]` faz backup, baixa o `compose.yml` da versão, troca a imagem,
espera ficar saudável e **volta sozinho** para a versão anterior se não ficar.

Para o GitHub Actions instalar cada tag publicada:

1. **No seu computador**, gere uma chave exclusiva de deploy (sem frase-senha, porque o CI não digita):
   `ssh-keygen -t ed25519 -N '' -C deploy-uptrue -f deploy_uptrue`
2. **No servidor**, autorize a chave **só** para o deploy (comando forçado + `restrict`):

   ```bash
   echo "command=\"/opt/uptrue/deploy-entry.sh\",restrict $(cat deploy_uptrue.pub)" >> ~/.ssh/authorized_keys
   ```

   Essa chave não abre terminal nem túnel e só aceita uma versão (`0.1.7`) como comando.
3. **No GitHub** (Settings → Environments → `production`):
   - secrets: `DEPLOY_HOST` (IP), `DEPLOY_USER` (`ubuntu`), `DEPLOY_SSH_KEY` (conteúdo de
     `deploy_uptrue`), `DEPLOY_KNOWN_HOSTS` (saída de `ssh-keyscan -t ed25519 IP`)
   - variável: `DEPLOY_URL` (ex.: `https://203-0-113-10.sslip.io`)
   - em Settings → Variables do repositório: `DEPLOY_ENABLED` = `true`
4. Apague a chave privada do seu computador depois de colar no GitHub.

Daí em diante, cada tag `v*` que passar em todos os testes é instalada no servidor. Para
instalar ou **voltar** uma versão à mão: Actions → Deploy → Run workflow.
