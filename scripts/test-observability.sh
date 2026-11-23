#!/usr/bin/env bash
# Testa o perfil de observabilidade de ponta a ponta: sobe a pilha num projeto separado e confere
# alvos do Prometheus, fontes de dados e dashboards do Grafana, CADA consulta de CADA painel,
# a chegada de logs e eventos ao Loki e o que fica (ou não) exposto.
#
#   scripts/test-observability.sh          # sobe, testa e derruba
#   KEEP=1 scripts/test-observability.sh   # mantém a pilha no ar depois do teste
#
# No Docker Desktop via WSL o cAdvisor não enxerga os containers (os caminhos montados vêm da
# distro, não da VM do Docker); use ALLOW_EMPTY_CONTAINERS=1 para tratar isso como aviso.
set -uo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-uptrue-obs-test}"
export AUTH_SECRET="${AUTH_SECRET:-obs-test-secret-0123456789abcdef}"
export METRICS_TOKEN="${METRICS_TOKEN:-obs-test-metrics-token-0123456789}"
export GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-obs-test-grafana-123}"
export UPTRUE_PORT="${UPTRUE_PORT:-3710}" GRAFANA_PORT="${GRAFANA_PORT:-3711}"
B="http://127.0.0.1:$UPTRUE_PORT"
G="http://127.0.0.1:$GRAFANA_PORT"
GA="admin:$GRAFANA_ADMIN_PASSWORD"
JAR="$(mktemp)"
FAILS=0

js() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }
# No GitHub Actions, cada falha vira anotação (visível no commit/PR sem abrir o log)
fail() { echo "FALHA $1"; FAILS=$((FAILS + 1)); [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Observabilidade::$1"; return 0; }
ok() { if [ "$2" = "true" ]; then echo "OK    $1"; else fail "$1 → ${2:-sem resposta}"; fi; }
# Porta não publicada: o "docker port" do Engine falha (formato estável). O "docker compose port"
# muda de formato entre versões (":0" local, "invalid IP:0" no runner do GitHub).
# Atenção: nada pode ir para a saída padrão aqui, porque o resultado é capturado por $(...).
unpublished() {
  local id
  id=$(docker compose ps -q "$1")
  [ -n "$id" ] && ! docker port "$id" "$2/tcp" >/dev/null 2>&1
}
cleanup() { rm -f "$JAR"; [ -n "${KEEP:-}" ] || docker compose --profile observability down -v >/dev/null 2>&1; }
trap cleanup EXIT

echo "== subindo a pilha (projeto $COMPOSE_PROJECT_NAME)"
docker compose --profile observability up -d --build >/tmp/obs-up.log 2>&1 || { fail "subida da pilha: $(tail -3 /tmp/obs-up.log | tr '
' ' ')"; tail -20 /tmp/obs-up.log; exit 1; }
for _ in $(seq 1 60); do curl -fsS "$B/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"obs@example.com","password":"obs-password-123"}' "$B/api/setup" >/dev/null
curl -fsS -b "$JAR" -H 'content-type: application/json' \
  -d '{"name":"Uptrue","url":"http://127.0.0.1:3000/healthz","interval_sec":30,"check_domain":false}' "$B/api/sites" >/dev/null
# Um site HTTPS real exercita os painéis de vencimento de SSL e de domínio
curl -fsS -b "$JAR" -H 'content-type: application/json' \
  -d '{"name":"GitHub","url":"https://github.com","interval_sec":30}' "$B/api/sites" >/dev/null
echo "aguardando coletas (100 s)…"
sleep 100

echo "== containers"
docker compose --profile observability ps --format '{{.Service}}: {{.State}}' | sort
for s in uptrue prometheus node-exporter cadvisor loki alloy grafana; do
  ok "container $s rodando" "$([ "$(docker compose ps "$s" --format '{{.State}}')" = running ] && echo true)"
done

echo "== Prometheus: alvos"
targets=$(docker compose exec -T prometheus wget -qO- http://localhost:9090/api/v1/targets)
for job in uptrue node cadvisor prometheus; do
  ok "alvo $job" "$(js "(d.data.activeTargets.find(t => t.labels.job === '$job') || {}).health === 'up'" <<<"$targets")"
done

echo "== Grafana"
ok "Grafana saudável" "$(curl -fsS "$G/api/health" | js 'd.database === "ok"')"
ok "sem senha: recusado" "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$G/api/search")" = 401 ] && echo true)"
ok "cadastro público desligado" "$([ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$G/api/user/signup")" != 200 ] && echo true)"
for uid in prometheus loki; do
  ok "fonte de dados $uid" "$(curl -fsS -u "$GA" "$G/api/datasources/uid/$uid/health" | js 'd.status === "OK"')"
done
ok "3 dashboards na pasta Uptrue" "$(curl -fsS -u "$GA" "$G/api/search?type=dash-db" | js 'd.filter(x => x.folderTitle === "Uptrue").length === 3')"

echo "== cada consulta de cada painel"
queries=$(node -e '
  const fs = require("fs"), dir = "observability/grafana/dashboards";
  for (const f of fs.readdirSync(dir)) {
    const d = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
    for (const p of d.panels) for (const t of p.targets)
      if (t.datasource.uid === "prometheus") console.log(JSON.stringify({ label: `${d.title} › ${p.title}`, expr: t.expr }));
  }')
while read -r line; do
  label=$(js 'd.label' <<<"$line")
  expr=$(js 'd.expr' <<<"$line")
  n=$(curl -fsS -u "$GA" -G "$G/api/datasources/proxy/uid/prometheus/api/v1/query" --data-urlencode "query=$expr" |
    js 'd.status === "success" ? d.data.result.length : "erro: " + d.error')
  if [[ "$n" =~ ^[1-9] ]]; then
    echo "OK    $label ($n séries)"
  elif [ -n "${ALLOW_EMPTY_CONTAINERS:-}" ] && [[ "$expr" == *container_* ]]; then
    echo "AVISO $label → sem dados (cAdvisor no Docker Desktop/WSL)"
  else
    fail "$label → $n  [$expr]"
  fi
done <<<"$queries"

echo "== coerência entre painéis"
# O card de CPU e a soma do gráfico "CPU por modo" têm de bater (em VMs/WSL parte do tempo
# não é contabilizada; dividir pelo número de núcleos inflava o card)
pq() { curl -fsS -u "$GA" -G "$G/api/datasources/proxy/uid/prometheus/api/v1/query" --data-urlencode "query=$1" | js 'Number((d.data.result[0] || { value: [0, "NaN"] }).value[1])'; }
card=$(pq '100 * (1 - sum(rate(node_cpu_seconds_total{mode="idle"}[5m])) / sum(rate(node_cpu_seconds_total[5m])))')
modes=$(pq 'sum(100 * sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / scalar(sum(rate(node_cpu_seconds_total[5m]))))')
ok "CPU: card ($card%) = soma por modo ($modes%)" "$(node -e "console.log(Math.abs($card - $modes) < 0.5)")"

echo "== Loki"
since="$(($(date +%s) - 900))000000000"
loki() { curl -fsS -u "$GA" -G "$G/api/datasources/proxy/uid/loki/loki/api/v1/query_range" --data-urlencode "query=$1" --data-urlencode "start=$since" --data-urlencode limit=5; }
ok "logs dos containers chegando" "$(loki "{project=\"$COMPOSE_PROJECT_NAME\"}" | js 'd.data.result.length > 0')"
ok "eventos do Uptrue com rótulo event" "$(loki '{service="uptrue", event="security.finding"}' | js 'd.data.result.length > 0')"

echo "== exposição"
ok "Grafana só em 127.0.0.1" "$(docker compose port grafana 3000 | grep -q '^127.0.0.1:' && echo true)"
ok "Prometheus não publicado" "$(unpublished prometheus 9090 && echo true)"
ok "Loki não publicado" "$(unpublished loki 3100 && echo true)"
ok "Alloy não publicado" "$(unpublished alloy 12345 && echo true)"

echo
if [ "$FAILS" -eq 0 ]; then echo "Tudo certo."; else echo "$FAILS falha(s)."; docker compose --profile observability logs --no-color --tail 30; fi
exit "$FAILS"
