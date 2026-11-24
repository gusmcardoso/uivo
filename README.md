<div align="center">

# Uivo

**Seu site está no ar de verdade?**

Monitor de saúde de sites, self-hosted e open source. Vai além do uptime: auditoria de segurança diária, detecção de adulteração, SSL e vencimento de domínio (inclusive `.com.br` no Registro.br), com uma nota de saúde de 0 a 100 e alertas no Telegram.

[![CI/CD](https://github.com/gusmcardoso/uivo/actions/workflows/ci.yml/badge.svg)](https://github.com/gusmcardoso/uivo/actions/workflows/ci.yml)
[![Licença: AGPL-3.0](https://img.shields.io/badge/licen%C3%A7a-AGPL--3.0-10b981)](LICENSE)
![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![Docker amd64 | arm64](https://img.shields.io/badge/docker-amd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white)

[Português](#português) · [English](#english)

</div>

![Painel do Uivo](docs/painel.webp)

---

## Português

> Até a v0.1.10 o projeto se chamava **Uptrue**. O nome mudou porque já existe outro produto de monitoramento com esse nome; instalações antigas continuam funcionando (veja a [migração](docs/DEPLOY.md#7-migração-de-uma-instalação-uptrue)).

### Por que mais um monitor?

Monitores tradicionais perguntam só *"o servidor respondeu?"*. O problema de quem mantém sites de clientes costuma ser outro: o site responde 200, mas a página está em branco, o SSL vence semana que vem ou o domínio expira sem ninguém perceber. O Uivo responde **"o site está saudável, seguro e funcionando para o cliente?"**: o Uptime Kuma diz se o servidor respondeu; o Uivo também diz se o `.env` vazou, se apareceu um script estranho na página ou se o certificado vence semana que vem.

### O que o Uivo faz

| Recurso | Detalhe |
| --- | --- |
| Checagem HTTP | Status, tempo de resposta e redirecionamentos, de 30 s a 1 h por site |
| **Sites atrás de firewall** | Reconhece desafios anti-bot (Vercel, Cloudflare, Sucuri, AWS WAF, DataDome, Akamai, Wordfence): verificação em camadas confirma DNS, conexão, TLS e resposta do servidor sem acusar queda falsa; cabeçalho de liberação por site para a verificação completa (v0.1.5) |
| **Onde o tempo foi gasto** | Cada checagem mede redirecionamentos, DNS, conexão, TLS, espera do servidor e download; gráfico em camadas, cascata da última checagem, p50/p95/p99, tamanho, compressão e um diagnóstico de qual etapa pesa mais e o que fazer (v0.1.3) |
| Palavra-chave | Opcional: só conta como no ar se o texto aparecer na página (pega página em branco com 200) |
| Confirmação de queda | Só declara "fora do ar" após 2 falhas seguidas, sem alarme falso |
| Certificado SSL | Dias até vencer, emissor e validade da cadeia; avisos com 14 e 3 dias |
| Vencimento de domínio | Via RDAP no servidor oficial de cada extensão (`.br` direto no Registro.br); avisos com 30 e 7 dias |
| Incidentes | Início, fim e duração de cada queda, com histórico de 90 dias |
| Painel | Uptime de 24 h, 7 e 30 dias, gráfico de tempo de resposta e vencimentos |
| **Detalhe de cada momento** | Passe o mouse no gráfico: resposta média, mínima e máxima, etapas, falhas e o motivo, comparados com o mesmo horário **ontem**, **há 7 dias** e o **normal daquele horário** (média dos 7 dias anteriores) (v0.2.0) |
| Alertas | Telegram: queda, volta (com duração) e vencimentos, sem repetir aviso |
| **Auditoria de segurança** | 1x ao dia: arquivos sensíveis expostos (`.env`, `.git`, backups, dumps SQL, `phpinfo`), cabeçalhos de segurança, HTTPS e redirecionamento, TLS obsoleto, conteúdo misto, listagem de diretório e versão do servidor exposta, cada achado com **como corrigir** (v0.1.2) |
| **Detecção de adulteração** | Script externo de domínio novo na página ou termos típicos de invasão (\"hacked by\", spam de cassino) viram alerta (v0.1.2) |
| **Nota de saúde 0–100** | Disponibilidade (40) + segurança (40) + validade de SSL e domínio (20) (v0.1.2) |
| **Relatório mensal em PDF** | Por mês e sites escolhidos: nota de saúde, uptime dia a dia, quedas (cortadas na virada do mês), tempo de resposta, pendências de segurança e vencimentos, com aviso de **cobertura parcial** quando o monitor ficou parado. Gerado no servidor, sem navegador (v0.1.10) |
| Página de status pública | `/status`, só com os sites marcados como públicos: estado atual e barras de 90 dias (v0.1.1) |
| Métricas Prometheus | `/metrics` protegido por token, pronto para o Grafana (v0.1.1) |

### Rodando com Docker

```bash
curl -O https://raw.githubusercontent.com/gusmcardoso/uivo/main/compose.yml
curl -o .env https://raw.githubusercontent.com/gusmcardoso/uivo/main/.env.example
# edite o .env: AUTH_SECRET (obrigatório) e, se quiser alertas, o Telegram
docker compose up -d
```

Abra `http://localhost:3000` e crie a conta de administrador no primeiro acesso. A imagem é publicada para **amd64 e arm64**, então roda também em Raspberry Pi e nas VMs ARM gratuitas da Oracle Cloud.

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `AUTH_SECRET` | sim | Assina o cookie de sessão (mín. 16 caracteres) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | não | Alertas no Telegram (sem eles, os alertas vão para o log) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | não | Cria o admin na subida, em vez do cadastro pelo painel |
| `RETENTION_DAYS` | não | Dias de histórico de checagens (padrão 90) |
| `CHECK_CONCURRENCY` | não | Checagens simultâneas (padrão 10) |
| `STATUS_PAGE_TITLE` | não | Título da página de status pública (padrão "Status dos serviços") |
| `METRICS_TOKEN` | não | Habilita o `/metrics` para o Prometheus (sem ele, o endpoint fica desligado) |

### Sites atrás de firewall (desafio anti-bot)

Vercel, Cloudflare e outros firewalls podem responder com um desafio ("verificando seu navegador") para quem não executa JavaScript, como qualquer monitor. Em vez de acusar queda falsa, o Uivo **reconhece o desafio** e verifica em camadas: se DNS, conexão, certificado e a resposta do servidor estão ok, o site está **no ar, com o conteúdo não verificado** (sem incidente, sem derrubar o uptime; aviso único no Telegram explicando como liberar).

O Uivo **não tenta resolver nem contornar** desafios. Para a verificação completa (página e palavra-chave), escolha uma forma autorizada:

| Forma | Como |
| --- | --- |
| Cabeçalho de liberação | Em **Editar → Cabeçalhos de liberação**, cadastre por exemplo `x-uivo-key` com um valor secreto e crie no firewall uma regra que libere quem enviar esse cabeçalho (Vercel: Custom Rule com ação *Bypass*; Cloudflare: WAF Custom Rule com ação *Skip*). O valor fica só no servidor e nunca é devolvido pela API |
| IP permitido | Libere o IP do servidor do Uivo no firewall |
| Endereço de saúde | Monitore um caminho que fique fora do desafio (ex.: `/healthz`) |

No Prometheus, `uivo_site_content_verified` é 0 enquanto o conteúdo estiver barrado.

### Onde o tempo foi gasto

"Respondeu em 420 ms" não diz o que fazer. O Uivo abre uma **conexão nova a cada checagem** (sem reaproveitar, para não mascarar DNS e TLS) e mede cada etapa separadamente. Se o servidor responde por mais de 40% do tempo, o painel diz isso e sugere o caminho (cache, CDN, DNS mais rápido, compressão).

![Tempo por etapa](docs/tempo.webp)

Proteções do cliente HTTP: no máximo 5 redirecionamentos, 5 MB de download medido, tempo limite valendo para a requisição inteira e teto de 10 MB na descompressão (uma "bomba de compressão" não derruba o monitor).

### Auditoria de segurança

Abra um site no painel e vá na aba **Segurança**: nota, achados ordenados por gravidade e o que fazer para corrigir cada um. A auditoria é **passiva**: só faz requisições GET ao que qualquer visitante já acessa, e confirma cada arquivo pelo **conteúdo** (um site que responde 200 para qualquer endereço não gera falso positivo). Use apenas em sites que você administra.

![Aba de segurança](docs/seguranca.webp)

Achados graves **novos** vão para o Telegram; o mesmo achado não é repetido no dia seguinte. Se você mesmo adicionou um script (analytics, chat), clique em **Aceitar scripts atuais**.

### Observabilidade completa (Grafana)

Um comando sobe a pilha inteira, já configurada, com dashboards prontos:

```bash
scripts/observability.sh init     # gera no .env só os segredos que faltam (nunca sobrescreve)
scripts/observability.sh up       # confere o ambiente, sobe e espera o Grafana (http://localhost:3001)
scripts/observability.sh status   # containers e saúde de cada alvo do Prometheus
scripts/observability.sh down     # para só a observabilidade; o Uivo continua e os dados ficam
```

O `up` confere antes de subir (segredos definidos e fortes, Docker respondendo, Compose 2.23+, porta do Grafana livre) e diz em português o que falta, em vez de deixar o compose falhar no meio. Sem o script, o equivalente é `docker compose --profile observability up -d` com `METRICS_TOKEN` e `GRAFANA_ADMIN_PASSWORD` no `.env`.

| Serviço | Papel |
| --- | --- |
| Prometheus | Coleta as métricas do Uivo, da máquina e dos containers (retenção de 15 dias) |
| node_exporter | CPU, memória, disco e rede do servidor |
| cAdvisor | Consumo de cada container |
| Loki + Alloy | Logs de todos os containers; os eventos do Uivo ganham o rótulo `event` |
| Grafana | Três dashboards provisionados: **Sites**, **Servidor** e **Containers** |

![Dashboard de sites no Grafana](docs/grafana.webp)

Segurança: só o Grafana é publicado, e em `127.0.0.1` (para acesso externo, coloque um proxy reverso com HTTPS na frente); Prometheus, Loki e Alloy ficam na rede interna; o token do `/metrics` e a senha do Grafana entram como *secrets* do compose, lidos do `.env`; cadastro público, acesso anônimo e telemetria do Grafana desligados.

Limitações conhecidas:

- o cAdvisor precisa de modo privilegiado e do namespace de cgroup do host; o Alloy lê o socket do Docker. É o padrão dessas ferramentas, mas dá a elas acesso amplo à máquina;
- no **Docker Desktop via WSL**, o painel de containers fica vazio: os caminhos montados vêm da distro, não da VM onde o Docker roda. Num servidor Linux funciona normalmente.

`scripts/test-observability.sh` sobe a pilha e confere cada parte: alvos do Prometheus, fontes de dados, dashboards, **cada consulta de cada painel**, logs e eventos no Loki e o que fica exposto. Ele roda no CI a cada push.

### Eventos para o Loki

Incidentes e achados de segurança saem como **JSON estruturado** no log do container (`"event":"incident.opened"`, `"incident.resolved"`, `"security.finding"`). Com Grafana Alloy (ou Promtail) coletando os logs do Docker, eles chegam ao Loki e aparecem no Grafana ao lado das métricas.

### Página de status pública

Marque um site como **público** no painel e ele aparece em `http://seu-servidor:3000/status`, sem login: estado atual, uptime e barras dos últimos 90 dias. Só o nome e o domínio são expostos. Dá para colocar no rodapé do site do cliente ou no seu portfólio.

![Página de status](docs/status.webp)

### Prometheus e Grafana

Com `METRICS_TOKEN` definido, o `/metrics` exporta `uivo_health_score`, `uivo_security_score`, `uivo_site_up`, `uivo_site_response_seconds`, `uivo_site_uptime_ratio` (24 h, 7 e 30 dias) e os vencimentos de SSL e domínio. Exemplo de `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: uivo
    scrape_interval: 60s
    authorization:
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ["uivo:3000"]
```

Alerta de SSL perto de vencer (`expr`): `uivo_ssl_expiry_timestamp_seconds - time() < 14 * 86400`.

### Produção (servidor com HTTPS e deploy automático)

O guia [docs/DEPLOY.md](docs/DEPLOY.md) cobre do zero: endurecimento do servidor, Docker, Traefik com HTTPS, backup diário testado e deploy automático pelo GitHub Actions.

| Script | Função |
| --- | --- |
| `scripts/update.sh [versão]` | backup → nova versão → espera ficar saudável → **rollback automático** se não ficar |
| `scripts/backup.sh` | cópia consistente do SQLite (`VACUUM INTO`), integridade conferida, compactada, 14 dias |
| `scripts/restore.sh` | restaura um backup: valida antes, salva o estado atual, troca o banco com segurança e confere |
| `scripts/offsite-backup.sh` | cópia **criptografada** para fora do servidor (rclone crypt; ex.: Object Storage da Oracle), 30 dias |
| `scripts/deploy-entry.sh` | porta de entrada da chave de deploy: só aceita uma versão como comando |

Cada tag `v*` que passa em todos os testes é publicada e instalada no servidor pelo workflow **Deploy**, que também permite instalar ou voltar uma versão à mão.

### Desenvolvimento

```bash
npm install
npm run dev        # API + agendador em http://localhost:3000
npm run dev:web    # painel com hot reload em http://localhost:5173
npm test           # testes (node:test)
npm run lint && npm run typecheck
```

### Arquitetura

| Parte | Tecnologia |
| --- | --- |
| API, agendador e checagens | Node 24 + TypeScript (executado direto, sem build) + Fastify |
| Banco | SQLite nativo do Node (`node:sqlite`): um arquivo, nenhuma dependência compilada |
| Painel | React 19 + Vite + Tailwind 4, gráficos com uPlot |
| Qualidade | Biome, `tsc`, `node:test` |
| Entrega | Docker multi-stage sem root, GitHub Actions, imagem multi-arquitetura no GHCR, Dependabot |

**Pipeline** (a cada push e pull request): lint, tipos, testes e build; a pilha de observabilidade sobe inteira e cada painel é consultado; o `update.sh` é testado como num servidor (atualiza, recusa versão inválida, faz rollback); depois sobe a imagem com `docker compose` e faz um teste de ponta a ponta (painel, API protegida, cadastro, o Uivo monitorando a si mesmo, página de status, `/metrics` com token, container sem root); na `main` e em tags `v*`, publica a imagem `amd64` + `arm64` no GHCR.

### Roadmap

- [x] **v0.1.0**: HTTP, SSL, domínio, incidentes, painel, alertas no Telegram
- [x] **v0.1.1**: página de status pública e `/metrics` para Prometheus/Grafana
- [x] **v0.1.2**: auditoria de segurança, detecção de adulteração, nota de saúde e eventos para o Loki
- [x] **v0.1.3**: tempo por etapa (DNS, conexão, TLS, servidor, download), percentis e diagnóstico
- [ ] **v0.2.0**: painel redesenhado, detalhe de cada ponto do gráfico comparado com dias anteriores, novo nome (**Uptrue → Uivo**) e nova marca; banco, backups e painéis antigos continuam valendo (o `uptrue.db` é adotado sozinho; veja [migração do servidor](docs/DEPLOY.md#7-migração-de-uma-instalação-uptrue)); `update.sh` faz rollback se a versão nova subir sem os dados
- [x] **v0.1.10**: relatório mensal em PDF (botão **Relatório** no painel e `/api/reports/monthly`)
- [x] **v0.1.9**: log do backup limpo, erros do backup externo em português e caminho completo no `--fetch`
- [x] **v0.1.8**: `restore.sh` testado e cópia externa criptografada dos backups (rclone crypt), ambos simulados no CI
- [x] **v0.1.7**: `update.sh` com backup e rollback automático, `backup.sh` testado, deploy automático por tag com chave restrita (comando forçado) e guia de deploy
- [x] **v0.1.6**: `scripts/observability.sh` (check, init, up, status, down, logs) com testes e ShellCheck no CI
- [x] **v0.1.5**: sites atrás de firewall: detecção de desafio anti-bot, verificação em camadas e cabeçalhos de liberação
- [x] **v0.1.4**: perfil de observabilidade (Prometheus, Grafana, Loki, Alloy, node_exporter, cAdvisor) com dashboards prontos e testados no CI
- [ ] Descoberta automática de sites pelo Traefik e por labels do Docker
- [ ] Alerta no WhatsApp (opcional)
- [ ] Regressão visual (print diário comparado com o anterior)
- [ ] Navegador de verdade: erros de JavaScript, recursos quebrados e teste sintético (botão do WhatsApp, formulário)
- [ ] Envio automático do relatório todo dia 1 (Telegram/e-mail)
- [ ] Painel em inglês

---

## English

**Is your site *really* up?** Uivo is a self-hosted, open-source site health monitor. Beyond plain uptime, it runs a daily passive security audit (exposed `.env`/`.git`/backups, security headers, TLS, tampering detection), computes a 0–100 health score, and tracks SSL certificate expiry and domain expiry through RDAP (using each TLD's official server, including Brazil's Registro.br), and sends Telegram alerts on downtime, recovery and upcoming expirations.

- **Quick start:** grab `compose.yml` and `.env.example`, set `AUTH_SECRET`, run `docker compose up -d`, then open `http://localhost:3000` and create the admin account.
- **Images:** multi-arch (`amd64`, `arm64`) on `ghcr.io/gusmcardoso/uivo`.
- **Stack:** Node 24 + TypeScript + Fastify, built-in `node:sqlite`, React + Vite + Tailwind.
- **Status:** v0.1.5 (development): uptime (with anti-bot challenge detection and layered verification for sites behind Vercel/Cloudflare firewalls), SSL and domain expiry, security audit with health score, per-phase timing, public status page, Prometheus metrics and a one-command observability profile (Grafana, Loki, Alloy, node_exporter, cAdvisor).

Licensed under **AGPL-3.0**: free to use, modify and self-host; if you offer a modified version as a network service, you must publish its source.

<br>

---

<div align="center">

Desenvolvido por **Gustavo Martins** · Analista de Sistemas · Fullstack & DevOps

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/gustavomartinsc)
[![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/gusmcardoso)

<sub>Código aberto sob a licença AGPL-3.0.</sub>

</div>
