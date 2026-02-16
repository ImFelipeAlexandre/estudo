type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
};

const rateLimitStore = new Map<string, RateLimitEntry>();

const hasControlChars = (value: string) => /[\x00-\x1F\x7F]/.test(value);

export const normalizeValue = (value?: string) => (value ?? "").trim();

export const extractClientIp = (request: Request) => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  return "unknown";
};

export const checkRateLimit = (
  key: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult => {
  const now = Date.now();
  const existing = rateLimitStore.get(key);

  if (!existing || existing.resetAt <= now) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });

    return {
      allowed: true,
      retryAfterMs: windowMs,
    };
  }

  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, existing.resetAt - now),
    };
  }

  existing.count += 1;
  rateLimitStore.set(key, existing);

  if (rateLimitStore.size > 1000) {
    for (const [entryKey, entryValue] of rateLimitStore.entries()) {
      if (entryValue.resetAt <= now) {
        rateLimitStore.delete(entryKey);
      }
    }
  }

  return {
    allowed: true,
    retryAfterMs: Math.max(0, existing.resetAt - now),
  };
};

export const validateCredentials = (
  accountName: string,
  appKey: string,
  appToken: string,
) => {
  if (!accountName || !appKey || !appToken) {
    return "Informe vendor, app key e app token.";
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/.test(accountName)) {
    return "Vendor inválido.";
  }

  if (
    appKey.length > 256 ||
    appToken.length > 512 ||
    hasControlChars(appKey) ||
    hasControlChars(appToken)
  ) {
    return "Credenciais inválidas.";
  }

  return null;
};

export const validateEntityIdentifier = (value: string, fieldLabel: string) => {
  if (!value) {
    return `${fieldLabel} é obrigatório.`;
  }

  if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(value)) {
    return `${fieldLabel} inválido.`;
  }

  return null;
};

export const sanitizePagination = (page?: number, pageSize?: number) => {
  const parsedPage = Number(page ?? 1);
  const parsedPageSize = Number(pageSize ?? 50);

  if (!Number.isInteger(parsedPage) || parsedPage < 1 || parsedPage > 10000) {
    return { error: "Página inválida." } as const;
  }

  if (
    !Number.isInteger(parsedPageSize) ||
    parsedPageSize < 1 ||
    parsedPageSize > 200
  ) {
    return { error: "Tamanho de página inválido." } as const;
  }

  return {
    page: parsedPage,
    pageSize: parsedPageSize,
  } as const;
};
