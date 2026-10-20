# Forge: documento de desenho

Status: desenho fechado em modo grill (2026-10-18) e revisado em nova rodada de grill (2026-10-19). Nenhum código escrito ainda.
Data: 2026-10-18 (revisão: 2026-10-19)

## 1. Ideia central

Um roteador de fluxo de trabalho que usa LLMs. Dada uma tarefa, ele conduz um pipeline fixo. O Forge não é um LLM: é um programa em TypeScript que decide a ordem das etapas, lê e escreve os artefatos e chama LLMs de terceiros em cada etapa.

```
1. Grill          → entrevista o usuário, uma pergunta por vez, até não restar dúvida
2. Reconhecimento → lê o projeto e gera o resumo de contexto (refeito a cada execução completa)
3. Tarefas        → escreve a lista de tarefas para atingir o objetivo
   (parada humana: aprovar | editar | cancelar)
4. Dev            → implementa o que foi escrito (por padrão em arena: N candidatos em paralelo, o Forge junta o melhor)
5. Revisão        → um agente revisor verifica o resultado (com ciclos de correção)
6. Lições         → propõe lições novas; o usuário aprova uma por uma
```

Em todas as etapas, os agentes devem observar:
- o padrão de projeto já implementado;
- compatibilidade com as tecnologias em uso;
- o contexto do projeto;
- que nada existente vai quebrar.

Origem dos prompts: skills de grill, planejamento, TDD e code review que a autora já usa, vindas de três repositórios open source sob licença MIT: `mattpocock/skills` (Matt Pocock), `backnotprop/pstack` (Lauren Tan) e `addyosmani/agent-skills` (Addy Osmani). O Forge adapta texto dessas skills, **com atribuição**: cada `SKILL.md` adaptado declara a origem no frontmatter e os avisos de copyright e licenças ficam em `THIRD_PARTY_LICENSES.md` (ver 4.12). Skills internas de qualquer empresa ou de outras fontes não entram.

## 2. Natureza do projeto

- Projeto pessoal da autora, **open source**, escrito em **TypeScript**, licença **MIT**.
- Nome do projeto: **Forge**. Comando: `forge-jj` (evita colidir com o `forge` do Foundry). Pacote no npm com escopo: `@<usuario>/forge`.
- **Sem nenhum material de empregador**: código, skills internas, nomes de sistemas e contexto interno de qualquer empresa ficam de fora. O projeto é desenvolvido e testado só com repositórios pessoais ou públicos. Usar com código de empresa seria uma decisão separada, com provedores aprovados.
- Não depende do ambiente local da autora (`~/.claude`, `projects.md`, `bkt`, skills pessoais). Prompts e skills do fluxo são genéricos e versionados no próprio repo.
- Configuração por repositório-alvo, em `.workflow.yml`.
- Cada usuário usa as próprias credenciais: o login dos CLIs (Claude Code, Copilot CLI) já feito na máquina. Na v1 o Forge não tem chave de API; as chaves só entram com os runners da seção 10 e serão lidas só de variável de ambiente.
- Pasta do projeto: `forge/`. Git local desde o início; o remoto (GitHub pessoal) só é criado depois, quando a v1 estiver de pé, e com confirmação antes de publicar.
- Publicar (GitHub pessoal e npm) é decisão da autora: o desenho não exige checagem prévia. Ficam registrados como fatos, e não como condição: a autora não verificou com o empregador a questão de propriedade intelectual sobre um projeto pessoal, e os termos de uso do GitHub para o `copilot-cli` não foram lidos (seção 9).

## 3. Como o Forge é usado

### 3.1 Instalação e execução
- Roda **dentro do repositório-alvo**, usando o `cwd` (como `git`, `eslint`, `prettier`): `forge-jj "adicionar login com Google"`.
- Durante o desenvolvimento: `npm link`. Depois, publicação no npm (`npm install -g` ou `npx`).
- Uma flag `--cwd <path>` pode vir depois, se fizer falta.

### 3.1.1 Pré-requisitos de execução
- **Só interativo na v1.** O Forge exige um terminal com TTY (`process.stdin.isTTY`) e recusa rodar sem ele, com uma mensagem de uma linha. O Grill, a parada humana, a aprovação de lições e a escalada da revisão precisam de uma pessoa. Os testes do próprio Forge rodam em CI com `Runner` falso e entrada simulada. Um modo não interativo fica na seção 10.
- **Git obrigatório.** O arena, a branch própria e o commit por lote dependem de git. Fora de um repositório git, o Forge recusa rodar e pede `git init`.
- **Árvore limpa na partida.** Com alterações não commitadas, o Forge pede para commitar ou guardar (`git stash`) antes de continuar.
- **Recusa `main` e `master`.** O Dev trabalha numa branch própria (4.6).
- **Uma execução por vez no repo.** Um lock simples recusa uma segunda execução ativa. Execuções em paralelo ficam fora da v1.

### 3.2 Perguntas depois do comando
Depois do comando, o Forge pergunta (Enter escolhe o padrão):

```
Qual o tamanho da tarefa?
  1) completo: com entrevista (padrão)
  2) trivial: pula o Grill

Como revisar?
  1) no final: o revisor confere tudo de uma vez (padrão)
  2) por tarefa: o revisor confere cada tarefa antes da próxima
```

As flags `--size` e `--review per_task` pulam as perguntas. Os padrões ficam no `.workflow.yml` (`review_mode: final`). Não há classificador automático de tamanho: quem escolhe é o usuário. O Dev roda em arena por padrão (4.14); `--no-arena` desliga e `--arena <n>` troca o número de candidatos. Em tarefa `trivial` o arena fica desligado por padrão.

Na `trivial` não há Grill, então uma chamada de leitura gera um `spec.md` mínimo a partir do texto do comando (Objetivo e Restrições tiradas do `context.md`), sem perguntas, com tudo marcado `(provisória)`. O spec aparece na parada humana junto com o `tasks.md`, para a pessoa corrigir. A `trivial` também reaproveita o último `context.md` (4.9).

### 3.3 Arquivos no projeto-alvo
```
meu-app/
  .workflow.yml          (configuração)
  .workflow/
    lessons.md           (lições aprendidas; compartilhado entre execuções)
    runs/
      <data>-<slug>/     (uma pasta por execução)
        context.md       (cópia do resumo compartilhado, que as etapas leem)
        spec.md          (saída do grill)
        tasks.md         (saída das tarefas)
        review.md        (saída da revisão)
        grill-draft.json (rascunho do grill; existe só até o spec.md ser gravado)
        arena/<lote>/    (rubrica, nota do arena; ver 4.14)
```

`forge-jj` sem argumento retoma a última execução incompleta. Cada execução tem a própria pasta, então uma segunda tarefa não sobrescreve a primeira.

Na primeira execução, o Forge acrescenta `.workflow/` e `.workflow.yml` ao `.git/info/exclude` (o "gitignore local"), sem duplicar e avisando em uma linha. O `.gitignore` do projeto nunca é alterado.

## 4. Decisões de arquitetura

### 4.1 Artefatos entre etapas
Cada etapa gera um arquivo e a seguinte lê o arquivo, não a conversa. Isso dá retomada, auditoria e contexto limpo. Se a estrutura de um artefato quebrar, o Forge pede ao modelo para regenerar, e o arquivo nunca fica meio escrito.

### 4.2 Provedor isolado atrás de uma "tomada" simples
O orquestrador nunca sabe qual provedor está por baixo. A interface é uma função:

```ts
export type Runner = (req: {
  prompt: string;       // instrução da etapa
  files: string[];      // arquivos que o agente pode ler
  canEdit: boolean;     // false = só lê, true = pode editar o projeto
}) => Promise<string>;  // texto do artefato produzido
```

Cada provedor é um arquivo pequeno em `runners/`. Sem plugin system nem registro dinâmico: um `import` direto num mapa. Só se adiciona campo à interface quando uma etapa real precisar.

### 4.3 Runner por etapa (a v1 nasce com dois runners: `claude-cli` e `copilot-cli`)
| Etapa | Edita arquivos? | Runner |
|---|---|---|
| Grill | Não | `claude-cli` (padrão) ou `copilot-cli`, só leitura |
| Reconhecimento | Não | `claude-cli` (padrão) ou `copilot-cli`, só leitura |
| Tarefas | Não | `claude-cli` (padrão) ou `copilot-cli`, só leitura |
| Dev | **Sim** | `claude-cli` (padrão) ou `copilot-cli`, em arena por padrão (4.14). O `copilot-cli` edita com as restrições da 4.6 |
| Revisão | Não | revisores em `claude-cli` e/ou `copilot-cli`, de modelos diferentes (4.13), só leitura |

O `claude-cli` roda `claude -p` como subprocesso, no `cwd` do repo-alvo, com `--output-format stream-json`, `--allowedTools` vindo de `dev.allowed_commands` e `--max-turns` (20 nas etapas de leitura). As chamadas de edição (`canEdit: true`) não têm limite de turnos nem de tempo, já que uma tarefa grande demora: `dev.max_turns` e `dev.timeout_minutes` só valem se forem preenchidos. As de leitura mantêm 20 turnos e 30 minutos. Nas etapas só de leitura (`canEdit: false`) libera apenas `Read`, `Grep` e `Glob`: sem `Edit`, `Write` nem `Bash`. É o padrão: usa o login do próprio Claude Code, sem API key. **Roda isolado por padrão** (`claude.isolated: true`): ignora settings, MCPs, hooks e skills do usuário e carrega só o `CLAUDE.md` do repo-alvo, para o resultado não depender da máquina de quem roda e para as permissões do Forge não serem contornadas. As flags que fazem esse isolamento foram validadas na versão 2.1.304 e estão na seção 9: `--setting-sources project`, `--strict-mcp-config`, `--disable-slash-commands` e `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Nas etapas somente leitura, usar `--tools Read,Grep,Glob` (que limita as ferramentas disponíveis), e não só `--allowedTools` (que só pré-aprova). `claude.isolated: false` desfaz o isolamento. Os runners `openrouter` e `claude-sdk` ficam fora da v1 (seção 10). Atenção à política de uso em 9.

O `copilot-cli` roda `copilot -p` como subprocesso, no mesmo molde do `claude-cli`: `cwd` no repo-alvo, `--model` vindo da configuração, `-s` para capturar só o texto (ou `--output-format json`, que traz um evento final `result` com `exitCode` e uso), `--no-ask-user` para o agente não parar e perguntar, `--no-custom-instructions` para não carregar `AGENTS.md` do alvo (reprodutibilidade), `--no-auto-update` e `--usage-output-file` para medir tokens. Nas etapas só de leitura: `--deny-tool write --deny-tool shell` (validado: o agente leu o arquivo e respondeu). No Dev: `--allow-tool write` e `--allow-tool 'shell(<comando>)'` por item de `dev.allowed_commands`; as permissões granulares funcionam em `-p` sem `--allow-all-tools`, apesar do texto do `--help`. Dá acesso a modelos de outras famílias, o que permite revisores e candidatos diferentes (4.13 e 4.14). Flags validadas na versão 1.0.100 (ver 9).

Nas etapas somente leitura o CLI roda com só as ferramentas de leitura liberadas. Na etapa de dev, escrever do zero as tools de edição e shell, com segurança, é um projeto à parte, então usa-se o agente pronto do CLI. Cada chamada é independente: o Forge guarda a conversa do Grill no rascunho e a reenvia no prompt (sem `--resume`); aproveitar a sessão do CLI (os dois têm `--resume`) fica como otimização futura. Os subagentes das etapas de leitura são chamadas isoladas ao mesmo runner, orquestradas pelo código (ver 4.13).

### 4.4 Configuração

```yaml
# .workflow.yml
steps:
  grill:  { runner: claude-cli, model: <modelo> }
  tasks:  { runner: claude-cli, model: <modelo> }
  dev:    { runner: claude-cli }   # ou copilot-cli, com as restrições da 4.6
claude:
  isolated: true            # só o CLAUDE.md do repo-alvo (ver 4.3)
  review:
    runner: claude-cli
    model: <modelo>          # síntese do veredito
    reviewers:               # um por modelo; podem misturar runners
      - { runner: claude-cli, model: <modelo A> }
      - { runner: copilot-cli, model: <modelo B> }
review_mode: final        # final | per_task
max_review_cycles: 10
max_lessons: 30
max_context_tokens:       # por conversa com o modelo; valores iniciais são estimativas
  warn: 80000
  limit: 100000
subagents:
  max_parallel: 3         # subagentes simultâneos (ver 4.13)
dev:
  allowed_commands: [npm test, npm run lint, npx prettier]
  # check_commands: [npm test, npm run lint]   # o que o arena roda para verificar o resultado (ver 4.14)
  # batching: per_task   # opcional: um Dev por tarefa mesmo com review_mode: final (ver 4.7)
  # max_turns: 200       # opcional: sem limite se não preenchido
  # timeout_minutes: 120 # opcional: sem limite se não preenchido
  arena:
    candidates: 3         # padrão; 1 desliga o arena (ver 4.14)
    models: [<modelo A>, <modelo B>, <modelo C>]   # opcional: um modelo por candidato (ver 4.14)
    judge: { runner: copilot-cli, model: <modelo> }   # de preferência de outra família que a do Dev
```

O repo traz um `.workflow.example.yml` com um modelo sugerido por etapa (mais forte no Grill e na Revisão, mais barato nas Tarefas). Trocar o provedor de uma etapa = mudar uma linha.

### 4.5 Credenciais
Na v1 não há chave de API do Forge. O `claude-cli` usa o login do Claude Code e o `copilot-cli` usa o login do Copilot CLI, ambos já feitos na máquina. Se `ANTHROPIC_API_KEY` estiver definida no ambiente, o `claude` a usa no lugar do login, então o runner deve avisar qual das duas está valendo. Na v1 o Forge só roda interativo (3.1.1); se um dia rodar sem pessoa, o token virá de variável de ambiente, nunca do repositório. As chaves de API (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` para o SDK) só voltam com os runners da seção 10.

### 4.6 Segurança da etapa de Dev
- O agente trabalha com `cwd` na pasta do projeto e só lê e edita dentro dela.
- Ferramentas liberadas: ler, buscar, editar e escrever arquivos. O Bash só roda os comandos listados em `dev.allowed_commands` do `.workflow.yml` (padrão: só o necessário para testar e formatar).
- Rede, `git push`, `rm -rf` e qualquer comando fora da lista ficam bloqueados. Nunca se usa `bypassPermissions`.
- O Dev só começa depois da aprovação do plano.
- **Branch própria e commit por lote.** Ao começar o Dev, o Forge cria a branch `forge/<slug>` e recusa rodar em `main` ou `master`. Cada lote aprovado na revisão vira um commit local, com mensagem padrão. O Forge nunca faz `git push`. Cancelar ou escalar ao humano deixa a branch como está; a pessoa pode ajustar, rebasear ou descartar.
- **O `copilot-cli` pode editar no Dev e nos candidatos do arena**, liberado em 2026-10-19 depois do teste de `--deny-tool` (seção 9, T2). Regras: `--allow-tool write`; `--allow-tool 'shell(<comando>)'` só para cada item de `dev.allowed_commands`; `--deny-tool` explícito, no formato de prefixo, para `git push`, `rm`, `curl` e `wget`; `--disallow-temp-dir`; nunca `--allow-all`, `--allow-all-tools` nem `--yolo`. Não testado: escrita fora do `cwd` (ver seção 9). O padrão do Dev continua sendo `claude-cli`.
- Com o arena (4.14), cada candidato edita só o próprio worktree, com as mesmas ferramentas e a mesma lista de comandos. Criar e remover worktrees é feito pelo código do Forge: o agente não recebe `git worktree` nem `git push`.
- No `copilot-cli`, `dev.allowed_commands` vira `--allow-tool 'shell(...)'`. **A lista não é fronteira rígida**: no teste, com só `shell(ls)` liberado, um `cat hello.txt` rodou mesmo assim (provavelmente o CLI aprova sozinho comandos de leitura; causa não confirmada), e um comando com redirecionamento foi negado. Por isso o Forge acrescenta `--deny-tool` explícito para `git push`, `rm`, `curl` e `wget` (a sintaxe de prefixo, `shell(rm:*)`, ainda precisa de teste) e nunca usa `--allow-all`, `--allow-all-tools` nem `--yolo`. Por padrão o CLI restringe o acesso ao `cwd` e ao diretório temporário; o Forge passa `--disallow-temp-dir`.

### 4.7 Orquestrador em lotes
O orquestrador roda um loop sobre lotes: `para cada lote: Dev (arena, ver 4.14) → Revisão → ciclos de correção`. No modo `final` há um lote com todas as tarefas; no `per_task`, um lote por tarefa. O código é o mesmo, só muda como a lista é dividida. Os ciclos de revisão são contados por lote.

**Dev por tarefa com revisão no final.** `dev.batching: per_task` com `review_mode: final` separa as duas divisões: o Dev roda uma chamada (ou arena) por tarefa, e a revisão continua uma só. Sem `dev.batching`, o Dev segue o `review_mode` (a revisão por tarefa exige um Dev por tarefa, e `dev.batching: all` com `review_mode: per_task` é recusado ao ler o `.workflow.yml`). Nesse modo cada tarefa é commitada assim que o Dev termina, antes da revisão, porque os worktrees do arena partem do `HEAD` e a tarefa seguinte precisa enxergar a anterior. O Forge guarda em `build.json`, na pasta da execução, o `HEAD` anterior à primeira tarefa (`base`), as tarefas que terminaram sem nada a commitar e se a revisão já acabou. A revisão final lê o diff contra essa `base`, com um prompt de no máximo 60 mil caracteres: acima disso os revisores recebem só o resumo por arquivo (`git diff --stat`) e leem os arquivos com `Read`. Os itens devolvidos ao Dev são agrupados pela tarefa citada, com uma chamada de correção por tarefa (os itens sem tarefa vão juntos em uma chamada extra), cada uma só com o markdown da tarefa citada. As correções viram um commit `forge: correções da revisão` com `Forge-Batch: review`. Se uma tarefa falha ou o arena escala, a execução para; rodar de novo retoma da tarefa que parou, pulando as commitadas e as de `build.json`. No código, Dev e Revisão são um único estágio (`build`, em `src/steps/build.ts`): cada lote só vira commit depois de aprovado, então os dois não podem ser etapas separadas do pipeline. O diff de cada lote vem dos commits (`git diff <commit-anterior>`), então o revisor vê só aquela fatia (4.6). Um lock recusa uma segunda execução ativa no mesmo repo (3.1.1).

### 4.8 Grill
CLI puro, com `readline`. O Forge faz **uma pergunta por vez**, cada uma com a resposta recomendada. O `spec.md` só é escrito depois que o usuário confirma. Uma TUI pode entrar depois, porque o grill só precisa de "mostrar texto" e "ler resposta". Regras do loop (validadas no protótipo `prototype-grill/`):

- **Sem limite de perguntas.** O grill termina quando há consenso: o modelo declara que não restam dúvidas e o usuário confirma o resumo.
- **`chega`** encerra a qualquer momento. O modelo só monta o resumo com o que já foi decidido, a pergunta que estava na tela vira ponto em aberto, e o usuário ainda confirma antes de gravar.
- **"Não sei"** é um pedido de ajuda, não uma resposta vazia: o modelo destrincha a pergunta, dá alternativas, explica o que cada uma influencia e mantém a recomendação com o motivo. Se o usuário continuar sem saber, o Forge segue a recomendação e marca a decisão como **provisória**, visível no resumo.
- **`depois`** é o único jeito de criar um ponto em aberto. Se o resumo ainda tiver pontos em aberto, o Forge avisa antes de seguir para as Tarefas.
- **Voltar** desfaz a última resposta e repete a pergunta; a pergunta que estava na tela é descartada e o modelo gera a próxima de novo. Não volta além de uma correção feita ao rejeitar o spec.
- **Ctrl+C** salva um rascunho em `.workflow/runs/<data>-<slug>/grill-draft.json`. Na próxima execução, o Forge pergunta se o usuário quer continuar ou recomeçar; o rascunho é apagado quando o `spec.md` é gravado.
- **Rejeitar o spec** exige dizer o que falta; a correção entra como decisão e o modelo volta ao grill.
- **Saída malformada do modelo**: o Forge pede de novo; na terceira falha seguida escala ao humano, com o progresso salvo no rascunho.

### 4.9 Reconhecimento do projeto
Antes das Tarefas, um passo lê o repo (estrutura, tecnologias, convenções, `CLAUDE.md`/`README`) e gera o `context.md`, guardado uma vez só em `.workflow/context.md` e copiado para a pasta de cada execução. O passo segue a skill `recon` (adaptada de `how`, com o formato de `context-engineering`) e responde a uma pergunta fixa: "como este projeto é construído e o que uma mudança precisa respeitar?". Em repositório pequeno (estimativa inicial: até 100 arquivos versionados) um único explicador lê e escreve o resumo. Nos maiores, três exploradores somente leitura rodam em paralelo (estrutura e stack; convenções e ferramentas; fluxo e fronteiras) e um explicador junta tudo (4.13). O `context.md` tem as seções Overview, Tech Stack, Commands, Code Conventions, Boundaries, Patterns, Project Map e Gotchas, em cerca de 1.500 palavras, e só traz comandos encontrados no repo. O resumo é **compartilhado entre execuções**, junto de `.workflow/context.json`, que guarda o commit (`HEAD`) em que foi feito. Uma execução completa só o refaz quando o repo mudou desde esse commit: há commit sem o trailer `Forge-Run` que toca algum arquivo fora de `.workflow/`, ou o commit guardado não existe mais (rebase, clone raso). Os commits do próprio Forge e os que só mexem em `.workflow/` não contam, então rodar o Forge em sequência não refaz o resumo à toa. Sem mudança, copia o arquivo e avisa a idade em uma linha ("contexto de 3 dias atrás: o repo não mudou desde então"). A execução `trivial` sempre reaproveita o resumo, mesmo com o repo mudado, e avisa disso; se não houver nenhum, gera um novo. `--refresh-context` força refazer em qualquer execução. A resposta do explicador é salva sem edição, então ela precisa começar no título `# Project:`; texto antes disso é recusado e a chamada se repete (4.13).

### 4.10 Parada humana
O fluxo para uma vez, depois das Tarefas, mostrando o `tasks.md`: `aprovar`, `editar` (abre o arquivo e depois continua), `cancelar` ou `rodar sem arena`. O Dev só começa depois do `aprovar`. Junto do `tasks.md` aparece uma linha com o **custo estimado do Dev em unidades relativas** (por exemplo, "~5 chamadas de Dev por lote, 3 lotes"), porque o `claude-cli` não informa o custo real. Na `trivial`, o `spec.md` mínimo provisório também aparece aqui. Entre as outras etapas não há parada.

### 4.11 Limite de contexto
O objetivo é proteger a **qualidade**: quanto mais tokens acumulam numa mesma conversa com o modelo, pior ele raciocina. Não é um limite de custo.
- Pesa mais no **Grill** (cada resposta reenvia a conversa inteira, e não há limite de perguntas) e no **Dev** (a sessão do agente acumula leituras e saídas de comandos). As outras etapas começam limpas, lendo só os arquivos de que precisam.
- Valores iniciais por conversa: **aviso em 80.000** e **ação em 100.000** tokens, configuráveis em `max_context_tokens` no `.workflow.yml`, por etapa. São estimativas, não medições; ajustar com a experiência de uso.
- Ao chegar no limite, o Forge **reinicia sozinho**: abre uma conversa nova que começa só com o resumo do que já foi decidido, e avisa em uma linha ("contexto em 100k: reiniciando com resumo"). No Grill, o resumo são as decisões tomadas (as mesmas do rascunho). No Dev, é o lote atual mais o `tasks.md`.
- Cada subagente (4.13) é uma conversa separada, com limite próprio, e começa limpo. O mesmo vale para cada candidato do arena (4.14); o integrador começa só com os diffs, a rubrica e o veredito do juiz.
- No `copilot-cli`, uma chamada trivial já carregou cerca de 17 mil tokens de prompt de sistema e ferramentas (medido com `--usage-output-file`). Esse custo fixo conta em cada chamada e em cada subagente, e `--usage-output-file` dá a contagem real para implementar os limites; o `--max-ai-credits` limita o gasto por sessão.
- Limite de **custo** (por execução ou por dia) fica fora do desenho por ora; o consumo aparece nos limites dos planos do Claude Code e do Copilot.

### 4.12 Skills do fluxo (`skills/`)
Os prompts de cada etapa vivem como arquivos versionados em `skills/`, não como strings no código:

```
skills/
  grill/SKILL.md
  recon/SKILL.md
  tasks/SKILL.md
  dev/SKILL.md
  review/SKILL.md
  lessons/SKILL.md
```

- Cada `SKILL.md` tem frontmatter (`name`, `description`, e `source`/`source_skill`/`license` quando adaptado) e o corpo em Markdown, no mesmo formato das skills do Claude Code. Assim podem ser lidas, revisadas e editadas sem tocar em TypeScript.
- O código só **carrega** o arquivo: `src/skills.ts` lê o `SKILL.md` da etapa, tira o frontmatter e entrega o texto ao runner: como system prompt (`--append-system-prompt`, no `claude-cli`) ou, onde o CLI não tem essa opção, no início do prompt. Nenhum prompt fica embutido em `steps/*.ts`.
- **Etapas só de leitura**: o texto vai no system prompt ou no início do prompt, conforme o runner. Não existe o conceito de skill ali; a skill é só prompt.
- **Dev**: o texto de `skills/dev/SKILL.md` é injetado pelo Forge, do mesmo jeito. O Forge **não** copia skills para o `.claude/skills/` do repo-alvo e não depende de `~/.claude/skills`: não altera o repo do usuário e o fluxo não varia com o que a pessoa tem instalado. O Claude Code ainda carrega as skills e o `CLAUDE.md` do próprio alvo, o que é desejado como contexto do projeto (ver 9).
- Cada etapa lê só a própria skill. O mesmo critério de qualidade (padrão do projeto, compatibilidade, contexto, nada quebra) é repetido em cada `SKILL.md`, porque as etapas não compartilham conversa.
- **Atribuição obrigatória.** A MIT exige manter o aviso de copyright e o texto da licença em tudo que for copiado ou adaptado. Regras:
  - cada `SKILL.md` que usa texto de terceiros declara no frontmatter `source` (repositório), `source_skill` (nome da skill original) e `license: MIT`; quando junta mais de uma origem, usa `sources:` com uma lista de `source` e `source_skill`; o que for escrito do zero não leva esses campos;
  - `THIRD_PARTY_LICENSES.md`, na raiz, reproduz o copyright e a licença de cada repositório de origem e acompanha o pacote publicado no npm;
  - o README cita as três fontes;
  - a ordem de checagem antes de publicar: toda skill adaptada tem `source` e a origem consta em `THIRD_PARTY_LICENSES.md`.
- Conteúdo adaptado também deve ser genérico e sem material de empregador (ver seção 2).
- O resumo comparativo das três coleções (em `Área de Trabalho/`) é anotação pessoal e **não entra no repo**.
- **Idioma:** o corpo dos `SKILL.md` fica em inglês, como nas fontes (menos tokens e mais fácil de acompanhar o original). O frontmatter `description` pode ficar em português. O modelo deve responder no idioma em que o usuário escreveu.
- Personalização pelo usuário (skills próprias por repo, sobrescrevendo as do Forge) fica fora da v1.

### 4.13 Subagentes
Na v1 um **subagente** é uma chamada isolada ao `Runner`, disparada pelo orquestrador (código, não o modelo): contexto novo, prompt próprio, sem acesso à conversa da etapa que o chamou, e só **lê** (`canEdit: false`). Devolve texto à etapa-mãe e acaba. Não é um agente persistente e não há framework de agentes. A interface `Runner` não muda (4.2).

Por que existem: isolar contexto. Cada subagente começa limpo e recebe só os arquivos ou o diff de que precisa, o que protege a qualidade (4.11) e evita que um eixo de análise contamine o outro.

**Onde são usados na v1**

| Etapa | Subagentes | Como volta para a etapa |
|---|---|---|
| Grill | busca de fatos do repo, quando uma pergunta depende de algo que está no código | o Forge dispara a busca enquanto o usuário responde a pergunta atual; se a próxima pergunta depende do fato, espera o resultado. O usuário nunca é perguntado sobre o que dá para ler no repo |
| Revisão | um revisor por modelo listado em `steps.review.reviewers`, em paralelo; a divergência vem da diversidade de modelos, não de papéis atribuídos. Depois, uma síntese que classifica cada achado (skill `review`, adaptada de `interrogate`) | o líder devolve um JSON validado com zod (veredito, quatro grupos, `previous_items` e mapa de concordância entre os modelos); o Forge regenera se vier malformado (4.1) e escreve o `review.md` em português. A intenção vem do `spec.md`; sem spec (tarefa trivial), vem do `tasks.md` e do diff |
| Lições | três lentes em paralelo (**judgment**, **tooling** e **divergent**, adaptadas da `reflect` da pstack), mais um **sintetizador** depois delas | lista de lições propostas, que o usuário aprova uma por uma (6.2) |
| Dev (arena) | um **juiz** somente leitura, depois dos candidatos (4.14) | veredito com pontuação por critério e a base recomendada |
| Reconhecimento | em repo maior, três **exploradores** em paralelo (estrutura e stack; convenções e ferramentas; fluxo e fronteiras), depois um **explicador** (4.9) | o explicador escreve o `context.md` da pasta da execução; em repo pequeno só ele roda, explorando sozinho |
| Tarefas | nenhum | — |

**Regras**
- Subagentes só leem. Nunca editam arquivos nem rodam comandos, e não criam outros subagentes. Os candidatos do arena (4.14) não são subagentes: são execuções do Dev, cada uma no seu worktree.
- Concorrência limitada por `subagents.max_parallel` (padrão 3). O sintetizador de Lições roda depois, não em paralelo.
- Por padrão usam o mesmo runner e modelo da etapa; `steps.<etapa>.subagents` pode trocar o modelo (por exemplo, um mais barato para a busca de fatos).
- Saída malformada ou falha de um subagente segue a regra do Grill (4.8): o Forge pede de novo; na terceira falha seguida escala ao humano, com o que já veio dos outros salvo. Um subagente que falha não derruba os que já terminaram.
- Cada subagente tem o próprio limite de contexto (4.11). O prompt de cada um é o `SKILL.md` da etapa mais a instrução do papel (`Padrões`, `Spec`, etc.).
- O resultado de cada subagente fica registrado no artefato da etapa, para auditoria.
- O Copilot CLI tem o modo `--fleet` (orquestração paralela de subagentes própria). O Forge não o usa, para que os dois runners se comportem igual.

**Custo:** mais chamadas por execução (a Revisão faz um por revisor mais a síntese, a cada ciclo; as Lições fazem as lentes mais 1). É o preço de contextos separados. Sem API key, todas essas chamadas contam nos limites dos planos do Claude Code e do Copilot. Limite de custo continua fora do desenho (4.11).

### 4.14 Arena no Dev
O Dev roda por padrão em modo **arena** (skill `dev`, adaptada de `arena`): em vez de um único agente, N candidatos implementam a mesma tarefa em paralelo, o Forge compara e junta o melhor. Evita que uma única tentativa trave a forma errada. É opcional: `--no-arena` ou `dev.arena.candidates: 1` desligam. Padrão: 3 candidatos (estimativa inicial). O arena roda **uma vez por lote** (4.7).

Fluxo de um lote:
1. **Rubrica.** Antes de lançar qualquer candidato, uma chamada de leitura deriva do `spec.md` e do `tasks.md` de 3 a 6 critérios verificáveis e grava em `arena/<lote>/rubric.md`, na pasta da execução. Os candidatos veem só a tarefa, nunca a rubrica.
2. **Candidatos.** O código cria N worktrees de git a partir do commit atual, em `.workflow/runs/<data>-<slug>/arena/<lote>/candidato-<n>/`, e roda o runner do Dev (`claude-cli`, ver 4.6) em cada um (`cwd` no worktree), em paralelo até `subagents.max_parallel`. Cada candidato entrega as mudanças e uma justificativa curta com as alternativas consideradas e rejeitadas.
3. **Juiz.** Quando todos terminam, um subagente somente leitura (4.13), de modelo `dev.arena.judge` (`claude-cli` ou `copilot-cli`, de preferência de outra família que a do Dev), vê a rubrica e o diff de cada candidato, pontua critério a critério e recomenda uma base.
4. **Base e enxerto.** Um agente de Dev com permissão de edição, no projeto real, lê todos os candidatos, pontua pela rubrica, compara com o juiz e escolhe a base que um mantenedor consegue estender com menos risco (em empate, a fronteira mais limpa ou a API menor). Depois enxerta à mão uma ou duas coisas de cada perdedor, sem colar mecanicamente. Se os candidatos convergem na mesma forma, vence o consenso, sem enxerto.
5. **Verificar.** Remove os worktrees e então roda `dev.check_commands` (padrão: `npm test` e `npm run lint`) no resultado, e segue para a Revisão normal do lote. Os worktrees saem antes porque ficam dentro do projeto: com eles ali, o lint e os testes leriam todas as cópias do código. A lista é separada de `dev.allowed_commands`, que diz o que um candidato pode rodar e pode ter formatadores que escrevem (`npx prettier`), sem sentido como verificação. O resultado só é registrado no `arena.md`, não bloqueia; quem decide é a Revisão.
6. **Nota.** `arena/<lote>/arena.md` (na pasta da execução) registra a base e o motivo, o veredito do juiz, cada enxerto e sua origem, o que foi rejeitado, convergência ou desistências e o resultado da verificação. Os worktrees são removidos ao fim; `.workflow/` inteiro fica fora do git do projeto-alvo (3.3).

Casos de borda:
- **Candidato sem saída:** segue com N−1 e registra a desistência. Com um só sobrando, ele é a base, sem enxerto. Com nenhum, escala ao humano.
- **Divergência total** (nenhuma base razoável): o Forge para e mostra ao humano. Não faz média.
- **Árvore suja:** não ocorre, porque o Forge só começa com a árvore limpa (3.1.1). Os worktrees partem do commit atual da branch `forge/<slug>`.
- **Tarefa `trivial`:** arena desligado por padrão (3.2).

**Custo.** O Dev passa a custar N candidatos, mais o juiz, mais a integração (cerca de 4 a 5 vezes um Dev simples com N = 3, estimativa). Com `claude-cli`, o limite do plano é consumido N vezes mais rápido. Com `copilot-cli`, o CLI mede o gasto em créditos de IA (por token) ou, na cobrança legada, em premium requests por prompt; no teste uma execução `-p` com 4 chamadas ao modelo contou 1 premium request. `--max-ai-credits` limita o gasto por sessão. Em `review_mode: per_task` o arena roda a cada tarefa, e o custo se multiplica por tarefa. Por padrão os candidatos usam o modelo do Dev. Com `dev.arena.models`, cada candidato usa um modelo diferente; no `copilot-cli` podem ser de famílias diferentes e no `claude-cli`, só modelos Claude. A estimativa relativa de custo aparece na parada humana (4.10), com a opção `rodar sem arena`. Mesmo sem a lista, a diversidade vem das tentativas independentes e do juiz de outra família.

## 5. Formato dos artefatos

### 5.1 `spec.md`
Seções fixas. Cada decisão tomada no Grill vira uma linha em **Decisões**; as decisões provisórias levam a marca `(provisória)`. **Pontos em aberto** só tem o que o usuário mandou deixar para `depois` (ou o que ficou sem resposta no `chega`); se sobrar algo, o Forge avisa antes de seguir. Não há campo de "como implementar". Na `trivial` (sem Grill), o spec é um texto mínimo gerado a partir do comando e do `context.md`, com todas as decisões marcadas `(provisória)` (3.2).

```markdown
# Spec: <título>

## Objetivo
## Decisões
## Fora do escopo
## Restrições
## Pontos em aberto
```

### 5.2 `tasks.md`
Uma seção por tarefa, com campos fixos. Todo critério de aceite é verificável (teste que passa, lint limpo, comportamento observável). O Dev marca as caixas `[x]` ao concluir.

```markdown
# Tarefas

## T1: <título>
- **Arquivos**: src/..., src/...
- **O que fazer**: ...
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste novo para ...
  - [ ] `npm run lint` sem erros
- **Depende de**: nenhuma
```

Quando falta uma decisão para quebrar o trabalho em tarefas, o `tasks.md` termina com uma seção opcional `## Dúvidas`: uma lista curta do que falta. Ela só existe nesse caso. O Forge mostra a seção na parada humana (4.10), junto com as tarefas.

### 5.3 `review.md`
Resumo no topo e um bloco por ciclo, com o problema do revisor e a resposta do Dev lado a lado. Cada problema aponta a tarefa (`T1`, `T2`) a que se refere.

```markdown
# Revisão

## Resumo
- **Veredito**: aprovado | escalado ao humano
- **Ciclos realizados**: 2 de 3
- **Motivo da escalada**: (só se escalado)

## Ciclo 1: reprovado
### Problemas apontados pelo revisor
1. [T1] ...
### Resposta do Dev
1. Corrigido: ...
2. Não corrigido: <justificativa>
### Anotados e descartados (não voltam ao Dev)
- Anotado: ...
- Descartado: ... (motivo)
```

### 5.4 `lessons.md`
Uma linha de Markdown por lição: a regra em uma frase, a data e a tarefa de origem. Editável à mão.

```markdown
- Toda rota nova precisa de teste de erro (2026-10-18, T3)
```

## 6. Revisão e aprendizado

### 6.1 Ciclos de revisão
- O líder da revisão (skill `review`) classifica os achados em quatro grupos: `act_on`, `consider`, `noted` e `dismissed`. **Reprova se houver qualquer item em `act_on` ou `consider`**, e o fluxo volta ao Dev com esses itens numerados. `noted` e `dismissed` ficam registrados no `review.md`, mas não voltam ao Dev nem gastam ciclo. Limite padrão de **10 ciclos** (`max_review_cycles`). **Ao chegar no limite, se sobrarem só itens `consider` (nenhum `act_on`), o lote é aprovado** e os itens restantes ficam anotados no `review.md`, sem voltar ao Dev: o revisor tende a inflar detalhes, e um lote que passa nos testes não deve ficar preso por isso (decidido depois do teste real da T27). Um `act_on` aberto continua escalando ao humano.
- Para cada problema, o Dev responde `corrigido` ou `não corrigido, com justificativa`.
- No ciclo seguinte, o revisor lê a justificativa e aceita ou mantém a exigência. Um item `consider` respondido com justificativa é encerrado, a menos que o líder o promova a `act_on`. Se um item `act_on` for mantido, o fluxo **escala direto ao humano**, sem gastar os ciclos restantes, com os dois lados lado a lado no `review.md`.
- Ao estourar o limite com um `act_on` aberto, o fluxo também para e entrega o `review.md` com o que sobrou. Com só `consider` aberto, o lote é aprovado (ver acima).
- O `review.md` registra o total de ciclos, o motivo de cada reprovação e o veredito final.

### 6.2 Aprendizado do revisor (memória de lições)
O modelo em si não muda e não há treino. O revisor "aprende" por memória:
- Os subagentes de Lições (lentes Judgment, Tooling e Divergent, mais um sintetizador, adaptados da `reflect` da pstack) leem só artefatos da execução (`review.md`, `arena.md`, `tasks.md`, `spec.md`) e o diff dos commits do lote. Nunca leem a conversa do Grill nem a transcrição da sessão do CLI.
- No fim de cada execução, o Forge propõe lições novas a partir do `review.md`: problemas que o revisor apontou mais de uma vez e divergências em que o usuário decidiu a favor de um dos lados.
- O usuário aprova cada proposta (`sim`, `não`, `editar`). **Nada é gravado sem aprovação**, porque uma lição errada contamina as revisões seguintes.
- `lessons.md` é lido por **revisor, Dev e Tarefas**. O Grill não lê.
- Limite de **30 lições** (`max_lessons`). Ao passar, no momento de aprovar uma nova, o Forge mostra as antigas e o usuário remove ou junta algumas. Nada é apagado sozinho.
- Alternativas descartadas por ora: busca em revisões passadas (embeddings) e fine-tuning de modelo. Podem ser reavaliadas se o histórico crescer.

## 7. Testes do próprio projeto

- O orquestrador é testado com um `Runner` falso que devolve respostas prontas: ordem das etapas, ciclos de revisão, divergência, escalada, retomada. Sem rede e sem gastar nada, rodando em CI sem chave.
- Ferramenta: `vitest`.
- O arena (`src/arena.ts`) é testado com `Runner` falso e um repositório git temporário: criação e remoção dos worktrees, desistência de candidatos (N−1, 1 e 0), árvore suja e convergência sem enxerto.
- O disparo de subagentes (`src/subagents.ts`) é testado com `Runner` falso: paralelismo e limite, falha de um subagente sem derrubar os outros, saída malformada e a regra das três falhas.
- Chamadas reais ao `claude -p` e ao `copilot -p` ficam num conjunto pequeno de testes manuais e separados, que só rodam com os CLIs instalados e logados.
- **Critério de "v1 pronta".** Rodar o Forge ponta a ponta em 2 ou 3 repositórios de teste pessoais ou públicos, com tarefas reais de tamanhos diferentes, guardadas em `test/manual/` com o resultado anotado. Para cada tarefa, comparar o Forge com arena, o Dev simples e o `claude` direto em custo relativo, nº de ciclos de revisão e testes passando. O arena só continua como padrão se ganhar ou empatar em qualidade.
- A CI do próprio Forge roda só o `vitest` com `Runner` falso e entrada simulada (o Forge exige TTY, 3.1.1).

## 8. Estrutura de arquivos prevista

```
forge/
  package.json, tsconfig.json, LICENSE (MIT)
  THIRD_PARTY_LICENSES.md  (copyright e licença das fontes das skills; ver 4.12)
  .gitignore            (com .env, por precaução)
  .workflow.example.yml
  skills/               (um SKILL.md por etapa; ver 4.12)
    grill/, recon/, tasks/, dev/, review/, lessons/
  src/
    runner.ts           (tipo Runner)
    skills.ts           (carrega o SKILL.md da etapa)
    subagents.ts        (dispara subagentes em paralelo com limite; ver 4.13)
    arena.ts            (worktrees, candidatos, juiz, integração; ver 4.14)
    runners/claude-cli.ts
    runners/copilot-cli.ts
    steps/grill.ts, recon.ts, tasks.ts, dev.ts, review.ts, lessons.ts
    artifacts.ts        (schemas, ex. com zod)
    orchestrator.ts     (loop de lotes)
    index.ts            (CLI: forge-jj)
  test/                 (vitest, com Runner falso)
    manual/             (tarefas de referência e resultados anotados; ver seção 7)
```

## 9. Notas técnicas sobre provedores

- **Agent SDK vs `claude -p`**: não é diferença de capacidade, é de ergonomia. O SDK dá hooks em código, loop em streaming, tipagem e versão fixada. O `claude-sdk` fica fora da v1 (a autora não tem API key para testá-lo). O `claude -p` (runner `claude-cli`, padrão na v1) não exige API key no projeto. Por isso o runner roda isolado por padrão (4.3).

  **Isolamento do `claude -p`, validado em 2026-10-19 na versão 2.1.304.** Medido no evento `init` de `--output-format stream-json --verbose`, num repositório de teste com um `CLAUDE.md` próprio:

  | Configuração | Ferramentas | Servidores MCP | Skills | Plugins |
  |---|---|---|---|---|
  | Sem flags (referência) | 203 | 53 | 165 | 7 |
  | `--setting-sources project` | 43 | 49 | 19 | 4 |
  | ... mais `--strict-mcp-config` | 29 | 0 | 19 | 4 |
  | ... mais `--disable-slash-commands` | 28 | 0 | 0 | 4 |
  | ... com `--tools Read,Grep,Glob` no lugar de `--allowedTools` | 3 | 0 | 0 | 4 |

  - `--setting-sources project` tira os settings, hooks e agentes do usuário, mas **não** os MCPs de conta (49 ficaram): precisa de `--strict-mcp-config` para zerar.
  - `--disable-slash-commands` zera skills e comandos.
  - `--tools` limita de fato as ferramentas disponíveis; `--allowedTools` só pré-aprova (com ele ainda havia 28). O runner deve usar `--tools` nas etapas somente leitura.
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` desliga a memória automática (`memory_paths` some do `init`).
  - Teste de comportamento: com as flags, o `CLAUDE.md` do repo-alvo foi lido e o `CLAUDE.md` global do usuário não.
  - **`--bare` não serve na v1:** ele nunca lê OAuth nem keychain e exige `ANTHROPIC_API_KEY`, o que contradiz o uso do login do Claude Code (4.5).
  - **Não isolável:** a política gerenciada da organização continua valendo (o modelo ainda via as instruções de administrador), e 4 plugins permaneceram (`cc-plugin-*`; a origem não foi confirmada, a suspeita é a política gerenciada). Esses itens variam por máquina e o Forge não os controla; o README deve avisar.
  - **Não validado:** o efeito de `--setting-sources project` quando o repo-alvo tem `.claude/settings.json` com hooks próprios (o desenho aceita isso como contexto do projeto), e o `--add-dir`. Custos: sobe um processo por chamada (mais latência), carrega `CLAUDE.md`, settings, MCPs e skills do diretório onde roda (o que pode tornar o resultado menos reprodutível) e o uso conta no limite do plano. Quanto à política: a da Anthropic não permite oferecer login claude.ai nem rotear pelo plano de assinatura de usuários em produtos de terceiros; quem constrói produto com o Agent SDK deve usar API key. Isso reforça o BYOK: como o `claude-cli` é o padrão, o README deve dizer de forma explícita que cada pessoa usa o próprio login só para si, que o Forge não oferece login nem compartilha credenciais, e que, na v1, o Forge é ferramenta local de uso pessoal: o runner `claude-sdk` com API key (seção 10) é o caminho previsto para produto ou serviço de terceiros.
- **`copilot-cli`**: mesma ergonomia do `claude-cli`, com modelos de outras famílias. Validado em 2026-10-19 na versão 1.0.100, com `copilot --help` e duas execuções reais em diretório de teste: `-p`, `-s`, `--model` (inclusive `auto`), `--no-ask-user`, `--no-custom-instructions`, `--output-format json`, `--usage-output-file`, `--deny-tool`/`--allow-tool` (`write`, `shell(...)`) e leitura somente com `--deny-tool write --deny-tool shell`. Ainda sem teste: nomes de ferramenta para `--available-tools`/`--excluded-tools`, e o `--resume`. A sintaxe de prefixo `shell(rm:*)` foi testada em 2026-10-19 (T2, abaixo). A cobrança vem em créditos de IA ou premium requests, conforme o plano. Os termos de uso do GitHub para um produto de terceiros orquestrar o Copilot CLI não foram confirmados: como no `claude-cli`, o README deve dizer que cada pessoa usa o próprio login só para si, e a confirmação dos termos não foi feita. Na v1 o `copilot-cli` fica ligado, inclusive para editar no Dev, com as restrições da 4.6 depois do teste de `--deny-tool` (abaixo).

  **Teste de `--deny-tool`, feito em 2026-10-19 (T2), `copilot` 1.0.100, `--model auto`.** Num diretório temporário, com um remoto git local, um arquivo descartável e um servidor HTTP em `127.0.0.1`. O efeito foi medido no disco ou no log do servidor, não só na resposta do modelo. Flags comuns: `-p -s --no-ask-user --no-custom-instructions --disallow-temp-dir`.

  | Comando | Só liberado (controle) | Liberado só `shell(ls)` + `--deny-tool 'shell(<cmd>:*)'` | Liberado o comando + o mesmo `--deny-tool` |
  |---|---|---|---|
  | `rm victim.txt` | rodou | bloqueado | bloqueado |
  | `git push origin HEAD:refs/heads/teste` | rodou | bloqueado | bloqueado |
  | `curl -s <url local>` | rodou | bloqueado | bloqueado |
  | `wget -q -O - <url local>` | rodou | bloqueado | bloqueado |

  - A sintaxe de prefixo `shell(rm:*)` funciona, e o `--deny-tool` vence o `--allow-tool` do mesmo comando.
  - Com só `shell(ls)` liberado, as formas indiretas também foram bloqueadas: `sh -c 'rm ...'`, `/bin/rm`, `env rm` e `find -delete` (4 de 4, arquivo intacto).
  - **Pegadinhas para o runner:** `curl` e `wget` com `-o`/`-O arquivo` foram negados mesmo liberados (gravar arquivo conta como escrita), e URLs exigem `--allow-url` à parte. Em uma execução anterior, comandos de leitura como `cat` rodaram sem estar na lista, então a lista de comandos continua não sendo fronteira rígida para leitura.
  - **Não testado:** escrita fora do `cwd` com `--allow-tool write`, outros modelos além de `auto`, e mais de uma tentativa por caso. Os testes de `curl` e `wget` com `-o` ficam fora do escopo do Dev.
- **OpenRouter** (fora da v1): dá os *modelos* do Claude e de outros provedores com uma key só, mas não os *agentes* do Claude. Roteamento do Claude Code via gateway só é suportado para modelos Claude. Apontar o Agent SDK para ele (`ANTHROPIC_BASE_URL`, uma chave só) seria opção experimental: é documentado para o Claude Code, e para o Agent SDK é inferência (falta testar); cache e betas dependem de o gateway repassar `cache_control` e os headers `anthropic-beta`.
- **API key em open source** (para os runners futuros): ler só de variável de ambiente, `.env` no `.gitignore`, `.env.example` sem valores, considerar pre-commit de detecção de segredos (ex.: gitleaks).
- **Outros caminhos, fora da v1**: orquestrar outros CLIs de agentes (além do `claude-cli` e do `copilot-cli`, que já estão na v1: Codex CLI, Gemini CLI, opencode, aider) como adaptadores adicionais; modelos locais (Ollama) para testes sem key.

## 10. Fora da v1

- Classificador automático de tamanho de tarefa.
- Cache de contexto que se invalida sozinho.
- TUI no lugar do `readline`.
- Runner `openrouter` (modelos de vários provedores com uma chave, via Vercel AI SDK) e runner `claude-sdk` (Claude Agent SDK, com `ANTHROPIC_API_KEY`). A autora não tem as chaves para testá-los; entram quando houver quem os teste. O `claude-sdk` é também o caminho previsto para uso em produto de terceiros.
- Adaptadores de outros agentes além do Claude Code CLI e do Copilot CLI.
- Busca em revisões passadas e fine-tuning para o aprendizado do revisor.
- Flag `--cwd`.
- Modo não interativo (sem TTY), com `--yes`, política para a parada e as escaladas, e sem aprovação de lições.
- Execuções em paralelo no mesmo repo.
- Skills personalizadas por repo-alvo, sobrescrevendo as de `skills/`.
- Subagentes que editam arquivos, rodam comandos ou criam outros subagentes.

## 11. Próximos passos

1. Renomear a pasta para `forge` e iniciar o git local (sem remoto).
2. Criar o esqueleto de código com um fluxo mínimo ponta a ponta: orquestrador com `Runner` falso e os testes de `vitest` primeiro.
3. Escrever o `SKILL.md` de cada etapa em `skills/` (com `source` quando adaptado de terceiros), implementar `src/skills.ts`, `src/subagents.ts`, `src/arena.ts`, os dois runners (`claude-cli` e `copilot-cli`) e as etapas, uma por vez.
4. Terminar a validação do `copilot-cli` (feita em parte em 2026-10-19; pendências na seção 9), incluindo o teste de `--deny-tool` que libera o Dev dele, (os termos de uso do GitHub para uso por produto de terceiros não foram lidos; ver seção 2).
5. ~~Antes de escrever o runner `claude-cli`, validar as flags que isolam o `claude -p`~~ Feito em 2026-10-19 (T1); resultado na seção 9.
6. Montar o conjunto de tarefas de referência em `test/manual/` (seção 7) e medir o arena contra o Dev simples e o `claude` direto.
7. O remoto no GitHub pessoal já existe. Publicar no npm fica para quando a autora decidir.
   - **Feito em 2026-10-20 (histórico):** sem chaves, sem `.env` e sem menção ao empregador no código nem no histórico. O e-mail corporativo do autor do commit `8c3ae02` foi reescrito para o e-mail pessoal e o `origin/main` foi atualizado com `git push --force-with-lease`.
   - **Não verificado, sem ser condição:** a checagem de IP com o empregador e a leitura dos termos do GitHub para o `copilot-cli`.
