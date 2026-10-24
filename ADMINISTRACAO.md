# Preço Certo — administração de mercados

## Fluxo de cadastro

1. O responsável cria a conta na área de administrador e confirma o e-mail, caso a confirmação esteja ativada.
2. O app envia uma solicitação para `public.market_applications` com status `pending`.
3. Enquanto estiver pendente, o usuário **não** tem vínculo em `public.market_admins` e não pode gerenciar produtos ou promoções.
4. Uma pessoa de confiança da equipe do Preço Certo analisa os dados e aprova ou rejeita a solicitação no SQL Editor do Supabase.
5. A aprovação cria o registro em `public.markets`, vincula o usuário em `public.market_admins` e atualiza a solicitação em uma única transação.

## Ver solicitações pendentes

No Supabase Dashboard, abra **SQL Editor** e execute:

```sql
select id, market_name, owner_name, address, phone, created_at
from public.market_applications
where status = 'pending'
order by created_at asc;
```

## Aprovar uma solicitação

Confira os dados primeiro. Substitua `123` pelo ID real da solicitação:

```sql
select * from private.approve_market_application(123);
```

A função só pode ser executada por `postgres` (SQL Editor) ou `service_role` em um backend confiável. Ela não é executável por usuários `anon` ou `authenticated`. **Nunca coloque uma chave `service_role` ou secret key no HTML, no GitHub ou no navegador.**

## Rejeitar uma solicitação

```sql
select * from private.reject_market_application(123);
```

## Verificar o vínculo após aprovação

```sql
select ma.user_id, ma.market_id, ma.role, m.n as market_name
from public.market_admins ma
join public.markets m on m.id = ma.market_id
order by ma.created_at desc;
```

Após a aprovação, peça ao responsável para entrar novamente ou tocar em **Verificar status** no app.

## Verificações operacionais antes do lançamento

- [ ] Em **Authentication → URL Configuration**, configurar a URL oficial do app e as URLs de redirecionamento.
- [ ] Em **Authentication → Providers**, habilitar Google somente depois de configurar as credenciais OAuth do Google.
- [ ] Em **Authentication → Security and Protection**, habilitar proteção contra senhas vazadas.
- [ ] Testar confirmação de e-mail e recuperação de senha.
- [ ] Testar o upload de uma foto JPEG/PNG/WebP de até 6 MB com uma conta autenticada.
- [ ] Confirmar que um administrador não consegue editar ofertas, promoções ou perfil de outro mercado.
- [ ] Lembrar que o bucket `market-photos` é público: só envie fotos que podem aparecer publicamente.
- [ ] Popular o banco com dados reais de mercados, ofertas e promoções antes do lançamento. Quando o banco estiver vazio, o HTML mantém os dados de demonstração localmente.

## Limitação atual

A aprovação é manual pelo SQL Editor. Para a equipe aprovar solicitações por uma tela administrativa no app, será necessário construir uma interface protegida ligada a um backend confiável ou a uma função segura de servidor; não se deve conceder poderes de aprovação a qualquer usuário autenticado.
## Importar tabela de preços com IA

O perfil do mercado tem um importador que recebe uma foto JPG, PNG ou WebP e usa um roteador automático de modelos de IA com visão. O app pede ao roteador que escolha um modelo compatível, em vez de fixar Gemini ou OpenAI no código. A foto é lida e convertida em uma prévia editável. **Os dados só entram em `public.offers` depois que o administrador confere a prévia e confirma.** Produtos do mesmo mercado com nome e tamanho correspondentes são atualizados; os demais são inseridos.

### Configurar a chave do serviço de IA (uma vez)

1. Crie uma conta no [OpenRouter](https://openrouter.ai/) e gere uma chave em https://openrouter.ai/settings/keys.
2. No Supabase Dashboard do projeto Preço Certo, abra **Edge Functions → Secrets** (ou **Project Settings → Edge Functions → Secrets**, conforme a interface).
3. Adicione o segredo com o nome exato `OPENROUTER_API_KEY` e o valor da chave do OpenRouter. Salve. **Não cole essa chave no HTML, no GitHub ou em mensagens.**
4. A função `read-price-table` está implantada com verificação de JWT ativada. Ela confirma a sessão e exige vínculo aprovado do usuário com o mercado antes de chamar o roteador. Não usa `service_role` no navegador.
5. Entre no perfil do mercado no app, envie uma foto legível e toque em **Ler tabela com IA**. Revise nomes, tamanhos, categorias e preços; depois toque em **Conferi tudo — salvar no Supabase**.

O modelo solicitado ao roteador é `openrouter/auto`: ele seleciona automaticamente um modelo elegível para a tarefa. Isso **não garante uso gratuito**; a resposta é cobrada conforme o modelo selecionado e a tabela de preços desse modelo. Configure limites de gasto na conta. Fotos enviadas são encaminhadas ao fornecedor de modelo escolhido pelo roteador, e as práticas de retenção/treinamento variam por fornecedor; revise as regras atuais do [OpenRouter](https://openrouter.ai/privacy/) antes de enviar tabelas confidenciais. A IA pode errar em fotos desfocadas, com reflexos, tabela inclinada ou números pequenos. Confirme cada preço antes de salvar.
