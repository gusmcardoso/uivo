#!/usr/bin/env bash
# Testa o update.sh como num servidor: pasta de deploy isolada começando numa versão antiga,
# depois atualização normal, versão inexistente (nada muda) e versão que não fica saudável
# a tempo (rollback automático). Usa imagens publicadas no GHCR.
#
#   FROM=0.1.5 TO=0.1.6 scripts/test-update.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO_DIR=$PWD

FROM="${FROM:-0.1.5}"
TO="${TO:-0.1.6}"
DIR=$(mktemp -d)
export COMPOSE_PROJECT_NAME=uptrue-update-test BACKUP_DIR="$DIR/backups"
PORT="${PORT:-3730}"
FAILS=0

ok() {
  if [ "$2" = true ]; then
    echo "OK    $1"
  else
    echo "FALHA $1 → ${2:-}"
    FAILS=$((FAILS + 1))
    # anotação com o motivo (sem quebras de linha), visível no commit sem abrir o log
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Atualização::$1 → $(printf '%s' "${2:-}" | tr '\n' ' ' | cut -c1-300)"
  fi
  return 0
}
running_tag() { docker inspect -f '{{.Config.Image}}' "$(docker compose ps -q uptrue)" 2>/dev/null | sed 's/.*://'; }
cleanup() { (cd "$DIR" && docker compose down -v >/dev/null 2>&1); rm -rf "$DIR"; }
trap cleanup EXIT

echo "== pasta de deploy simulada em $DIR, começando na $FROM"
cp "$REPO_DIR"/scripts/{update.sh,backup.sh} "$DIR/"
cd "$DIR" || exit 1
curl -fsSL "https://raw.githubusercontent.com/gusmcardoso/uptrue/v$FROM/compose.yml" -o compose.yml
printf 'AUTH_SECRET=%s\nUPTRUE_TAG=%s\nUPTRUE_PORT=127.0.0.1:%s\n' "$(openssl rand -hex 32)" "$FROM" "$PORT" >.env
docker compose up -d --no-build >/dev/null 2>&1
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -c jar -H 'content-type: application/json' -d '{"email":"t@example.com","password":"senha-de-teste-123"}' "http://127.0.0.1:$PORT/api/setup" >/dev/null
curl -fsS -b jar -H 'content-type: application/json' -d '{"name":"Teste","url":"http://127.0.0.1:3000/healthz","check_domain":false}' "http://127.0.0.1:$PORT/api/sites" >/dev/null
ok "rodando na $FROM" "$([ "$(running_tag)" = "$FROM" ] && echo true)"

echo "== 1. atualização normal ($FROM → $TO)"
# Mantém o update.sh da árvore de trabalho (o passo 6 trocaria pelos scripts publicados da versão)
out=$(./update.sh "$TO" 2>&1); code=$?
cp "$REPO_DIR"/scripts/{update.sh,backup.sh} .
ok "update.sh terminou sem erro" "$([ $code = 0 ] && echo true || echo "código $code: $(echo "$out" | tail -3)")"
ok "agora na $TO" "$([ "$(running_tag)" = "$TO" ] && echo true || running_tag)"
ok ".env com UPTRUE_TAG=$TO" "$(grep -qx "UPTRUE_TAG=$TO" .env && echo true)"
ok "backup feito antes de atualizar" "$(ls "$BACKUP_DIR"/uptrue-*.db.gz >/dev/null 2>&1 && echo true)"
ok "dados preservados (site continua cadastrado)" "$(curl -fsS -b jar "http://127.0.0.1:$PORT/api/sites" | grep -q '"name":"Teste"' && echo true)"

echo "== 2. versão inexistente (nada pode mudar)"
out=$(./update.sh 9.9.9 2>&1); code=$?
ok "recusada com erro" "$([ $code != 0 ] && echo true)"
ok "continua na $TO" "$([ "$(running_tag)" = "$TO" ] && echo true || running_tag)"
ok "compose.yml e .env intactos" "$([ ! -f compose.yml.bak ] && grep -qx "UPTRUE_TAG=$TO" .env && echo true)"
ok "nenhum backup feito para versão inexistente" "$([ "$(ls "$BACKUP_DIR"/uptrue-*.db.gz | wc -l)" = 1 ] && echo true || ls "$BACKUP_DIR")"
out=$(./update.sh 'abc;rm -rf /' 2>&1); code=$?
ok "versão com formato inválido recusada" "$([ $code != 0 ] && echo "$out" | grep -q 'versão inválida' && echo true)"

echo "== 3. nova versão não fica saudável a tempo (rollback automático para $TO)"
out=$(HEALTH_TIMEOUT=1 ./update.sh "$FROM" 2>&1); code=$?
ok "update.sh sinaliza a falha" "$([ $code != 0 ] && echo true)"
ok "mensagem de rollback concluído" "$(echo "$out" | grep -q 'rollback concluído' && echo true || echo "$out" | tail -2)"
ok "voltou para a $TO e está saudável" "$([ "$(running_tag)" = "$TO" ] && curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null && echo true || running_tag)"
ok ".env restaurado (UPTRUE_TAG=$TO)" "$(grep -qx "UPTRUE_TAG=$TO" .env && echo true)"

echo
if [ "$FAILS" = 0 ]; then echo "Tudo certo."; else echo "$FAILS falha(s)."; fi
exit "$FAILS"
