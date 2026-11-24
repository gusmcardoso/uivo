#!/usr/bin/env bash
# Testa backup.sh, restore.sh e offsite-backup.sh como num servidor (pasta de deploy isolada).
# O "destino externo" é um remote local criptografado pelo rclone (crypt), no lugar da nuvem.
#
#   scripts/test-backup-restore.sh   (usa a imagem gerada da árvore de trabalho)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO_DIR=$PWD

PORT="${PORT:-3740}"
DIR=$(mktemp -d)
export COMPOSE_PROJECT_NAME=uivo-restore-test BACKUP_DIR="$DIR/backups"
FAILS=0

ok() {
  if [ "$2" = true ]; then
    echo "OK    $1"
  else
    echo "FALHA $1 → ${2:-}"
    FAILS=$((FAILS + 1))
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Backup/restore::$1 → $(printf '%s' "${2:-}" | tr '\n' ' ' | cut -c1-300)"
  fi
  return 0
}
api() { curl -fsS -b "$DIR/jar" -H 'content-type: application/json' "$@"; }
site_count() { api "http://127.0.0.1:$PORT/api/sites" | grep -o '"id":' | wc -l; }
cleanup() { (cd "$DIR" && docker compose down -v >/dev/null 2>&1); docker rmi uivo-restore-test:local >/dev/null 2>&1; docker run --rm -v "$DIR:/d" alpine rm -rf /d/rclone /d/backups >/dev/null 2>&1; rm -rf "$DIR"; }
trap cleanup EXIT

echo "== servidor simulado em $DIR (imagem da árvore de trabalho)"
docker build -q -t uivo-restore-test:local . >/dev/null || { echo "build da imagem falhou"; exit 1; }
cp "$REPO_DIR"/scripts/{backup.sh,restore.sh,offsite-backup.sh} "$DIR/"
cd "$DIR" || exit 1
cp "$REPO_DIR/compose.yml" compose.yml
printf 'AUTH_SECRET=%s\nUIVO_IMAGE=uivo-restore-test\nUIVO_TAG=local\nUIVO_PORT=127.0.0.1:%s\n' "$(openssl rand -hex 32)" "$PORT" >.env
docker compose up -d --no-build >/dev/null 2>&1
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -c "$DIR/jar" -H 'content-type: application/json' -d '{"email":"t@example.com","password":"senha-de-teste-123"}' "http://127.0.0.1:$PORT/api/setup" >/dev/null
api -d '{"name":"Antigo","url":"http://127.0.0.1:3000/healthz","check_domain":false}' "http://127.0.0.1:$PORT/api/sites" >/dev/null

echo "== backup"
out=$(./backup.sh 2>&1)
ok "saída do backup limpa (uma linha, sem progresso do docker)" "$([ "$(printf '%s\n' "$out" | wc -l)" = 1 ] && ! printf '%s' "$out" | grep -q Copy && echo true || printf '%s' "$out")"
first=$(ls -1t "$BACKUP_DIR"/uivo-*.db.gz | head -1)
ok "backup criado" "$([ -f "$first" ] && echo true)"
api -d '{"name":"Novo","url":"http://127.0.0.1:3000/healthz","check_domain":false}' "http://127.0.0.1:$PORT/api/sites" >/dev/null
ok "2 sites depois do backup" "$([ "$(site_count)" = 2 ] && echo true || site_count)"

echo "== restore"
out=$(./restore.sh "$(basename "$first")" --yes 2>&1); code=$?
ok "restore terminou sem erro" "$([ $code = 0 ] && echo true || echo "$out" | tail -2)"
ok "voltou ao estado do backup (1 site)" "$([ "$(site_count)" = 1 ] && echo true || site_count)"
ok "o site antigo está lá, o novo não" "$(api "http://127.0.0.1:$PORT/api/sites" | grep -q '"name":"Antigo"' && ! api "http://127.0.0.1:$PORT/api/sites" | grep -q '"name":"Novo"' && echo true)"
ok "estado anterior salvo antes de restaurar (desfazível)" "$([ "$(ls "$BACKUP_DIR"/uivo-*.db.gz | wc -l)" = 2 ] && echo true)"
ok "o Uivo continua gravando depois do restore" "$(api -d '{"name":"Depois","url":"http://127.0.0.1:3000/healthz","check_domain":false}' "http://127.0.0.1:$PORT/api/sites" >/dev/null && [ "$(site_count)" = 2 ] && echo true)"

echo "== backup com o nome antigo (uptrue-*.db.gz, de antes da troca de nome) continua restaurável"
cp "$first" "$BACKUP_DIR/uptrue-2026-01-01_000000_0.db.gz"
touch -d '2026-01-01' "$BACKUP_DIR/uptrue-2026-01-01_000000_0.db.gz"
ok "--list mostra o backup antigo" "$(./restore.sh --list | grep -q 'uptrue-2026-01-01_000000_0.db.gz' && echo true)"
out=$(./restore.sh uptrue-2026-01-01_000000_0.db.gz --yes 2>&1); code=$?
ok "restore do backup antigo sem erro" "$([ $code = 0 ] && echo true || echo "$out" | tail -2)"
ok "estado do backup antigo restaurado (1 site)" "$([ "$(site_count)" = 1 ] && echo true || site_count)"
api -d '{"name":"Depois","url":"http://127.0.0.1:3000/healthz","check_domain":false}' "http://127.0.0.1:$PORT/api/sites" >/dev/null
rm -f "$BACKUP_DIR/uptrue-2026-01-01_000000_0.db.gz"

echo "== restore recusa arquivos ruins sem tocar nos dados"
head -c 2000 /dev/urandom >"$BACKUP_DIR/uivo-corrompido.db.gz"
out=$(./restore.sh uivo-corrompido.db.gz --yes 2>&1); code=$?
ok "gzip corrompido recusado" "$([ $code != 0 ] && echo "$out" | grep -q 'corrompido' && echo true)"
echo 'isto não é um banco' | gzip >"$BACKUP_DIR/uivo-nao-e-banco.db.gz"
out=$(./restore.sh uivo-nao-e-banco.db.gz --yes 2>&1); code=$?
ok "arquivo que não é banco recusado" "$([ $code != 0 ] && echo "$out" | grep -q 'integridade' && echo true)"
ok "dados intactos após as recusas (2 sites)" "$([ "$(site_count)" = 2 ] && echo true || site_count)"
rm -f "$BACKUP_DIR"/uivo-corrompido.db.gz "$BACKUP_DIR"/uivo-nao-e-banco.db.gz

echo "== backup externo criptografado (rclone crypt sobre um destino local)"
mkdir -p rclone/destino && chmod 700 rclone
pass=$(docker run --rm rclone/rclone:1.69.1 obscure "senha-de-teste-do-crypt")
cat >rclone/rclone.conf <<EOF
[nuvem]
type = local

[offsite]
type = crypt
remote = nuvem:/config/destino
password = $pass
EOF
chmod 600 rclone/rclone.conf
./backup.sh >/dev/null
latest=$(ls -1t "$BACKUP_DIR"/uivo-*.db.gz | head -1)
name=$(basename "$latest")
sum=$(sha256sum "$latest" | cut -d' ' -f1)
out=$(./offsite-backup.sh 2>&1); code=$?
ok "envio confirmado" "$([ $code = 0 ] && echo true || echo "$out" | tail -2)"
stored=$(find rclone/destino -type f | head -1)
ok "chegou um arquivo no destino" "$([ -n "$stored" ] && echo true)"
ok "nome criptografado no destino" "$([ -n "$stored" ] && ! basename "$stored" | grep -q uivo && echo true || basename "$stored")"
ok "conteúdo criptografado (não é gzip legível)" "$([ -n "$stored" ] && [ "$(head -c 2 "$stored" | od -An -tx1 | tr -d ' ')" != 1f8b ] && echo true)"
ok "--list mostra o backup pelo nome real" "$(./offsite-backup.sh --list | grep -q "$name" && echo true)"
rm -f "$latest"
out=$(./offsite-backup.sh --fetch "$name" 2>&1); code=$?
ok "--fetch traz de volta" "$([ $code = 0 ] && [ -f "$latest" ] && echo true || echo "$out" | tail -2)"
ok "arquivo recuperado idêntico ao original (sha256)" "$([ -f "$latest" ] && [ "$(sha256sum "$latest" | cut -d' ' -f1)" = "$sum" ] && echo true)"
out=$(./offsite-backup.sh --fetch '../../etc/passwd' 2>&1); code=$?
ok "--fetch mostra o caminho completo para o restore" "$(BACKUP_DIR=$BACKUP_DIR ./offsite-backup.sh --fetch "$name" 2>&1 | grep -q "restore.sh $BACKUP_DIR/$name" && echo true)"
out=$(OFFSITE_REMOTE=nuvem:/config/nao-existe/ ./offsite-backup.sh --list 2>&1); code=$?
ok "destino inexistente explicado em português" "$([ $code != 0 ] && echo "$out" | grep -q 'bucket não encontrado' && echo true || echo "$out" | tail -1)"
ok "--fetch recusa nome fora do padrão" "$([ $code != 0 ] && echo true)"

echo
if [ "$FAILS" = 0 ]; then echo "Tudo certo."; else echo "$FAILS falha(s)."; fi
exit "$FAILS"
