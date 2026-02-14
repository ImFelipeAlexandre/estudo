# Projeto Next.js pronto para GitHub + Vercel

Projeto criado com Next.js (App Router), TypeScript, ESLint e Tailwind CSS.

## Rodar localmente

```bash
npm install
npm run dev
```

Acesse `http://localhost:3000`.

## Scripts principais

```bash
npm run dev     # desenvolvimento
npm run lint    # checagem de lint
npm run build   # build de produção
npm run start   # sobe build de produção local
```

## Integração com GitHub

Este projeto já inclui pipeline em `.github/workflows/ci.yml` para:

- instalar dependências (`npm ci`)
- rodar lint (`npm run lint`)
- rodar build (`npm run build`)

### Publicar no GitHub

```bash
git add .
git commit -m "feat: iniciar projeto Next.js"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

## Deploy na Vercel

1. Entre em [https://vercel.com/new](https://vercel.com/new)
2. Importe o repositório do GitHub
3. Framework detectado: **Next.js**
4. Clique em **Deploy**

Depois disso, cada push no `main` gera novo deploy automaticamente na Vercel.

## Proteção da branch `main`

Depois de criar o repositório no GitHub e fazer login no CLI:

```bash
gh auth login
gh repo set-default SEU_USUARIO/SEU_REPOSITORIO
gh api \
	-X PUT \
	repos/SEU_USUARIO/SEU_REPOSITORIO/branches/main/protection \
	-H "Accept: application/vnd.github+json" \
	-f required_status_checks.strict=true \
	-F required_status_checks.contexts[]='build-and-lint' \
	-f enforce_admins=true \
	-f required_pull_request_reviews.dismiss_stale_reviews=true \
	-f required_pull_request_reviews.required_approving_review_count=1 \
	-f restrictions=
```

Isso exige PR com 1 aprovação e CI passando antes de merge na `main`.
