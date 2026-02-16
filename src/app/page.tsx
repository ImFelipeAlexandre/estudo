"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

const LOCAL_STORAGE_CREDENTIALS_KEY = "vtex.md.quick.credentials";

type Version = "v1" | "v2";

type Credentials = {
  accountName: string;
  appKey: string;
  appToken: string;
};

type Entity = {
  acronym: string;
  name?: string;
  schema?: string;
};

type V2ManualTarget = {
  acronym: string;
  schema?: string;
};

type PaginationState = {
  page: number;
  pageSize: number;
  total: number | null;
  totalPages: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
};

const INITIAL_PAGINATION: PaginationState = {
  page: 1,
  pageSize: 50,
  total: null,
  totalPages: null,
  hasPrevious: false,
  hasNext: false,
};

const entityId = (entity: Entity) => `${entity.acronym}::${entity.schema ?? ""}`;

const toCsv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "";

  const headers = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row))),
  );

  const escapeCell = (value: unknown) => {
    const parsed =
      typeof value === "string" ? value : JSON.stringify(value ?? "");
    return `"${parsed.replaceAll('"', '""')}"`;
  };

  const lines = [headers.join(",")];

  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCell(row[header])).join(","));
  });

  return lines.join("\n");
};

const downloadFile = (content: string, filename: string, type: string) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const fetchEntities = async (
  credentials: Credentials,
  version: Version,
): Promise<Entity[]> => {
  const response = await fetch("/api/vtex/entities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, version }),
  });

  const payload = (await response.json()) as {
    entities?: Entity[];
    error?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error ?? "Falha ao carregar entidades.");
  }

  return payload.entities ?? [];
};

export default function Home() {
  const [credentials, setCredentials] = useState<Credentials>({
    accountName: "",
    appKey: "",
    appToken: "",
  });
  const [session, setSession] = useState<Credentials | null>(null);
  const [saveCredentialsLocally, setSaveCredentialsLocally] = useState(false);
  const [entitiesV1, setEntitiesV1] = useState<Entity[]>([]);
  const [entitiesV2, setEntitiesV2] = useState<Entity[]>([]);
  const [activeVersion, setActiveVersion] = useState<Version>("v1");
  const [selectedEntityId, setSelectedEntityId] = useState<string>("");
  const [records, setRecords] = useState<Record<string, unknown>[]>([]);
  const [pagination, setPagination] = useState<PaginationState>(INITIAL_PAGINATION);
  const [viewMode, setViewMode] = useState<"table" | "json">("table");
  const [v2EntityQuery, setV2EntityQuery] = useState("");
  const [v2SchemaQuery, setV2SchemaQuery] = useState("");
  const [v2SearchedEntityQuery, setV2SearchedEntityQuery] = useState("");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [loadingEntities, setLoadingEntities] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableScrollState, setTableScrollState] = useState({
    showHint: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const resizingStateRef = useRef<{
    column: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const tableScrollContainerRef = useRef<HTMLDivElement | null>(null);

  const filteredV2Entities = useMemo(() => {
    const term = v2SearchedEntityQuery.trim().toLowerCase();

    if (!term) {
      return entitiesV2;
    }

    return entitiesV2.filter((entity) => {
      const source = `${entity.acronym} ${entity.name ?? ""} ${entity.schema ?? ""}`;
      return source.toLowerCase().includes(term);
    });
  }, [entitiesV2, v2SearchedEntityQuery]);

  const currentEntities =
    activeVersion === "v1" ? entitiesV1 : filteredV2Entities;

  const selectedEntity = useMemo(
    () => currentEntities.find((entity) => entityId(entity) === selectedEntityId),
    [currentEntities, selectedEntityId],
  );

  const manualV2Target = useMemo<V2ManualTarget | null>(() => {
    const acronym = v2EntityQuery.trim();
    if (!acronym) {
      return null;
    }

    const schema = v2SchemaQuery.trim();
    return {
      acronym,
      schema: schema || undefined,
    };
  }, [v2EntityQuery, v2SchemaQuery]);

  const effectiveEntity =
    activeVersion === "v2" ? selectedEntity ?? manualV2Target : selectedEntity;

  const columns = useMemo(
    () => Array.from(new Set(records.flatMap((record) => Object.keys(record)))),
    [records],
  );

  const totalTableWidth = useMemo(
    () =>
      columns.reduce(
        (sum, column) => sum + (columnWidths[column] ?? 220),
        0,
      ),
    [columns, columnWidths],
  );

  const updateTableScrollState = useCallback(() => {
    const element = tableScrollContainerRef.current;

    if (!element) {
      setTableScrollState({
        showHint: false,
        canScrollLeft: false,
        canScrollRight: false,
      });
      return;
    }

    const hasHorizontalOverflow = element.scrollWidth - element.clientWidth > 2;
    const canScrollLeft = element.scrollLeft > 2;
    const canScrollRight =
      element.scrollLeft + element.clientWidth < element.scrollWidth - 2;

    setTableScrollState({
      showHint: hasHorizontalOverflow,
      canScrollLeft,
      canScrollRight,
    });
  }, []);

  const filePrefix = useMemo(() => {
    if (!effectiveEntity) return `masterdata-${activeVersion}`;
    const schemaPart = effectiveEntity.schema ? `-${effectiveEntity.schema}` : "";
    return `${effectiveEntity.acronym}${schemaPart}-${activeVersion}`;
  }, [activeVersion, effectiveEntity]);

  useEffect(() => {
    if (!currentEntities.length) {
      setSelectedEntityId("");
      return;
    }

    if (!currentEntities.some((entity) => entityId(entity) === selectedEntityId)) {
      setSelectedEntityId(entityId(currentEntities[0]));
    }
  }, [currentEntities, selectedEntityId]);

  useEffect(() => {
    const savedRaw = window.localStorage.getItem(LOCAL_STORAGE_CREDENTIALS_KEY);
    if (!savedRaw) {
      return;
    }

    try {
      const saved = JSON.parse(savedRaw) as Credentials;
      if (saved.accountName && saved.appKey && saved.appToken) {
        setCredentials(saved);
        setSaveCredentialsLocally(true);
      }
    } catch {
      window.localStorage.removeItem(LOCAL_STORAGE_CREDENTIALS_KEY);
    }
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const resizing = resizingStateRef.current;
      if (!resizing) return;

      const nextWidth = Math.max(
        120,
        resizing.startWidth + (event.clientX - resizing.startX),
      );

      setColumnWidths((previous) => ({
        ...previous,
        [resizing.column]: nextWidth,
      }));
    };

    const onMouseUp = () => {
      resizingStateRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    const raf = window.requestAnimationFrame(updateTableScrollState);

    const onResize = () => {
      updateTableScrollState();
    };

    window.addEventListener("resize", onResize);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [updateTableScrollState, records, columns, totalTableWidth, viewMode]);

  const loadVersionEntities = async (version: Version, creds: Credentials) => {
    const loadedEntities = await fetchEntities(creds, version);
    if (version === "v1") {
      setEntitiesV1(loadedEntities);
      return;
    }
    setEntitiesV2(loadedEntities);
  };

  const handleAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoadingAuth(true);

    try {
      const [loadedV1, loadedV2] = await Promise.all([
        fetchEntities(credentials, "v1"),
        fetchEntities(credentials, "v2"),
      ]);

      setSession(credentials);
      setEntitiesV1(loadedV1);
      setEntitiesV2(loadedV2);
      setActiveVersion("v1");
      setV2EntityQuery("");
      setV2SchemaQuery("");
      setV2SearchedEntityQuery("");
      setSelectedEntityId(loadedV1.length ? entityId(loadedV1[0]) : "");
      setRecords([]);
      setPagination(INITIAL_PAGINATION);
      setColumnWidths({});
      setViewMode("table");

      if (saveCredentialsLocally) {
        window.localStorage.setItem(
          LOCAL_STORAGE_CREDENTIALS_KEY,
          JSON.stringify(credentials),
        );
      } else {
        window.localStorage.removeItem(LOCAL_STORAGE_CREDENTIALS_KEY);
      }
    } catch (authError) {
      setError(
        authError instanceof Error
          ? authError.message
          : "Não foi possível autenticar na VTEX.",
      );
    } finally {
      setLoadingAuth(false);
    }
  };

  const handleRefreshEntities = async () => {
    if (!session) return;

    setError(null);
    setLoadingEntities(true);
    try {
      await loadVersionEntities(activeVersion, session);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Falha ao atualizar entidades.",
      );
    } finally {
      setLoadingEntities(false);
    }
  };

  const loadDataPage = async (targetPage: number, targetPageSize: number) => {
    if (!session || !effectiveEntity) return;

    setError(null);
    setLoadingData(true);
    try {
      const response = await fetch("/api/vtex/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...session,
          version: activeVersion,
          entity: effectiveEntity.acronym,
          schema: effectiveEntity.schema,
          page: targetPage,
          pageSize: targetPageSize,
        }),
      });

      const payload = (await response.json()) as {
        records?: Record<string, unknown>[];
        pagination?: PaginationState;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Não foi possível carregar registros.");
      }

      setRecords(payload.records ?? []);
      setPagination(payload.pagination ?? INITIAL_PAGINATION);
      setColumnWidths({});
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Erro ao carregar dados.",
      );
      setRecords([]);
      setPagination(INITIAL_PAGINATION);
    } finally {
      setLoadingData(false);
    }
  };

  const handleLoadData = async () => {
    await loadDataPage(1, pagination.pageSize);
  };

  const handleExportCsv = () => {
    if (!records.length) return;
    downloadFile(toCsv(records), `${filePrefix}.csv`, "text/csv;charset=utf-8;");
  };

  const handleExportJson = () => {
    if (!records.length) return;
    downloadFile(
      JSON.stringify(records, null, 2),
      `${filePrefix}.json`,
      "application/json;charset=utf-8;",
    );
  };

  const handleExportXls = () => {
    if (!records.length) return;
    const worksheet = XLSX.utils.json_to_sheet(records);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Dados");
    XLSX.writeFile(workbook, `${filePrefix}.xlsx`);
  };

  const handleSearchV2Entities = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRecords([]);
    setPagination(INITIAL_PAGINATION);
    setV2SearchedEntityQuery(v2EntityQuery.trim());
  };

  const handlePreviousPage = async () => {
    if (!pagination.hasPrevious || loadingData) return;
    await loadDataPage(pagination.page - 1, pagination.pageSize);
  };

  const handleNextPage = async () => {
    if (!pagination.hasNext || loadingData) return;
    await loadDataPage(pagination.page + 1, pagination.pageSize);
  };

  const handlePageSizeChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextPageSize = Number(event.target.value);
    setPagination((previous) => ({ ...previous, pageSize: nextPageSize }));

    if (!effectiveEntity) {
      return;
    }

    await loadDataPage(1, nextPageSize);
  };

  const startColumnResize = (
    event: React.MouseEvent<HTMLButtonElement>,
    column: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const fallbackWidth = 220;
    const startWidth = columnWidths[column] ?? fallbackWidth;

    resizingStateRef.current = {
      column,
      startX: event.clientX,
      startWidth,
    };
  };

  if (!session) {
    return (
      <div className="min-h-screen overflow-x-hidden bg-slate-100 px-4 py-8 text-slate-900 sm:py-12">
        <div className="mx-auto w-full max-w-xl rounded-2xl bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold tracking-widest text-blue-600">
            VTEX CONFIG
          </p>
          <h1 className="mt-3 text-4xl font-semibold">Conectar Conta</h1>

          <form className="mt-8 space-y-5" onSubmit={handleAuth}>
            <label className="block space-y-2">
              <span className="text-sm font-semibold uppercase tracking-wide text-slate-600">
                Vendor Name
              </span>
              <input
                className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 outline-none focus:border-blue-500"
                value={credentials.accountName}
                onChange={(event) =>
                  setCredentials((previous) => ({
                    ...previous,
                    accountName: event.target.value.trim(),
                  }))
                }
                placeholder="ex: minhaaccount"
                required
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-semibold uppercase tracking-wide text-slate-600">
                App Key
              </span>
              <input
                className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 outline-none focus:border-blue-500"
                value={credentials.appKey}
                onChange={(event) =>
                  setCredentials((previous) => ({
                    ...previous,
                    appKey: event.target.value,
                  }))
                }
                placeholder="vtexappkey-..."
                required
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-semibold uppercase tracking-wide text-slate-600">
                App Token
              </span>
              <input
                type="password"
                className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 outline-none focus:border-blue-500"
                value={credentials.appToken}
                onChange={(event) =>
                  setCredentials((previous) => ({
                    ...previous,
                    appToken: event.target.value,
                  }))
                }
                placeholder="••••••••••••••••••"
                required
              />
            </label>

            <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
              <input
                type="checkbox"
                checked={saveCredentialsLocally}
                onChange={(event) => setSaveCredentialsLocally(event.target.checked)}
              />
              Salvar dados neste dispositivo para consulta rápida (local)
            </label>

            {error ? (
              <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
            ) : null}

            <button
              type="submit"
              disabled={loadingAuth}
              className="w-full rounded-xl bg-blue-600 px-4 py-3 text-lg font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
            >
              {loadingAuth ? "Conectando..." : "Acessar MasterData"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-100 p-3 text-slate-900 sm:p-4 lg:p-7">
      <div className="mx-auto flex w-full max-w-[1400px] min-w-0 flex-col gap-4 sm:gap-6 lg:flex-row">
        <aside className="w-full rounded-2xl bg-white p-4 shadow-sm sm:p-6 lg:w-80">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Configuração
          </p>

          <div className="mt-4 rounded-xl bg-slate-100 p-1">
            <div className="grid grid-cols-2 gap-1 text-sm font-semibold">
              <button
                className={`rounded-lg px-3 py-2 ${
                  activeVersion === "v1" ? "bg-white text-slate-900" : "text-slate-500"
                }`}
                onClick={() => {
                  setActiveVersion("v1");
                  setRecords([]);
                  setPagination(INITIAL_PAGINATION);
                  setError(null);
                }}
                type="button"
              >
                V1 (DS)
              </button>
              <button
                className={`rounded-lg px-3 py-2 ${
                  activeVersion === "v2" ? "bg-white text-slate-900" : "text-slate-500"
                }`}
                onClick={() => {
                  setActiveVersion("v2");
                  setRecords([]);
                  setPagination(INITIAL_PAGINATION);
                  setError(null);
                }}
                type="button"
              >
                V2 (MD)
              </button>
            </div>
          </div>

          {activeVersion === "v1" ? (
            <label className="mt-5 block space-y-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Entidade V1
              </span>
              <select
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-blue-500"
                value={selectedEntityId}
                onChange={(event) => {
                  setSelectedEntityId(event.target.value);
                  setRecords([]);
                  setPagination(INITIAL_PAGINATION);
                }}
              >
                {!entitiesV1.length ? (
                  <option value="">Nenhuma entidade encontrada</option>
                ) : null}
                {entitiesV1.map((entity) => (
                  <option key={entityId(entity)} value={entityId(entity)}>
                    {entity.name ?? entity.acronym}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="mt-5 space-y-3">
              <span className="block text-xs font-semibold uppercase tracking-wider text-slate-500">
                Nome da entidade V2
              </span>
              <form onSubmit={handleSearchV2Entities} className="flex gap-2">
                <input
                  className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 outline-none focus:border-blue-500"
                  placeholder="Ex: CL, CN, newsletter"
                  value={v2EntityQuery}
                  onChange={(event) => {
                    setV2EntityQuery(event.target.value);
                    setSelectedEntityId("");
                  }}
                />
                <button
                  type="submit"
                  className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  Buscar
                </button>
              </form>

              <input
                className="w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 outline-none focus:border-blue-500"
                placeholder="Schema (opcional)"
                value={v2SchemaQuery}
                onChange={(event) => setV2SchemaQuery(event.target.value)}
              />

              {filteredV2Entities.length > 0 ? (
                <select
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none focus:border-blue-500"
                  value={selectedEntityId}
                  onChange={(event) => {
                    setSelectedEntityId(event.target.value);
                    setRecords([]);
                    setPagination(INITIAL_PAGINATION);
                  }}
                >
                  {filteredV2Entities.map((entity) => (
                    <option key={entityId(entity)} value={entityId(entity)}>
                      {entity.name ?? entity.acronym}
                      {entity.schema ? ` (${entity.schema})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="rounded-xl bg-slate-100 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Sem lista de entidades para o filtro atual. Use o campo manual para consultar.
                </p>
              )}
            </div>
          )}

          <button
            className="mt-4 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            type="button"
            onClick={handleRefreshEntities}
            disabled={loadingEntities}
          >
            {loadingEntities ? "Atualizando..." : "Atualizar lista"}
          </button>

          <button
            className="mt-8 w-full rounded-xl border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50"
            type="button"
            onClick={() => {
              setSession(null);
              setRecords([]);
              setPagination(INITIAL_PAGINATION);
              setError(null);
            }}
          >
            Sair / Reset
          </button>
        </aside>

        <main className="min-w-0 w-full max-w-full flex-1 overflow-hidden rounded-2xl bg-white p-4 shadow-sm sm:p-5 lg:p-6">
          <div className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-2xl font-bold uppercase sm:text-3xl">
                {effectiveEntity?.acronym ?? "-"}
              </h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Vendor: {session.accountName} • Versão: {activeVersion.toUpperCase()}
              </p>
              {activeVersion === "v2" && v2SearchedEntityQuery ? (
                <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Busca V2: &quot;{v2SearchedEntityQuery}&quot; • {filteredV2Entities.length} resultado(s)
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold hover:bg-slate-200 disabled:opacity-50"
                onClick={handleExportCsv}
                disabled={!records.length}
              >
                CSV Completo
              </button>
              <button
                type="button"
                className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold hover:bg-slate-200 disabled:opacity-50"
                onClick={handleExportXls}
                disabled={!records.length}
              >
                XLS Completo
              </button>
              <button
                type="button"
                className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold hover:bg-slate-200 disabled:opacity-50"
                onClick={handleExportJson}
                disabled={!records.length}
              >
                JSON Completo
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 sm:gap-3">
            <button
              type="button"
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              onClick={handleLoadData}
                disabled={!effectiveEntity || loadingData}
            >
              {loadingData ? "Carregando..." : "Carregar dados"}
            </button>

              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs sm:text-sm">
                <span className="text-slate-500">Por página</span>
                <select
                  className="rounded-md bg-slate-100 px-2 py-1 outline-none"
                  value={pagination.pageSize}
                  onChange={handlePageSizeChange}
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>

              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs sm:text-sm">
                <button
                  type="button"
                  className="rounded-md bg-slate-100 px-2 py-1 font-semibold disabled:opacity-40"
                  onClick={handlePreviousPage}
                  disabled={!pagination.hasPrevious || loadingData || !records.length}
                >
                  ←
                </button>
                <span className="font-semibold text-slate-600">
                  Página {pagination.page}
                  {pagination.totalPages ? ` / ${pagination.totalPages}` : ""}
                </span>
                <button
                  type="button"
                  className="rounded-md bg-slate-100 px-2 py-1 font-semibold disabled:opacity-40"
                  onClick={handleNextPage}
                  disabled={!pagination.hasNext || loadingData || !records.length}
                >
                  →
                </button>
              </div>

              <div className="rounded-xl bg-slate-100 p-1 text-xs font-semibold sm:text-sm">
              <button
                type="button"
                className={`rounded-lg px-3 py-1.5 ${
                  viewMode === "table" ? "bg-white" : "text-slate-500"
                }`}
                onClick={() => setViewMode("table")}
              >
                Dados
              </button>
              <button
                type="button"
                className={`rounded-lg px-3 py-1.5 ${
                  viewMode === "json" ? "bg-white" : "text-slate-500"
                }`}
                onClick={() => setViewMode("json")}
              >
                JSON
              </button>
            </div>
          </div>

          {error ? (
            <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
          ) : null}

          <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            {pagination.total !== null
              ? `Total de registros: ${pagination.total}`
              : "Total de registros indisponível para esta consulta."}
          </p>

          {viewMode === "table" ? (
            <div className="relative mt-4 w-full max-w-full overflow-hidden rounded-xl border border-slate-200 bg-white">
              {tableScrollState.showHint ? (
                <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full bg-slate-900/80 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white shadow-sm">
                  Arraste lateral ↔
                </div>
              ) : null}

              <div
                ref={tableScrollContainerRef}
                onScroll={updateTableScrollState}
                className="w-full max-w-full min-w-0 overflow-x-auto overscroll-x-contain [webkit-overflow-scrolling:touch]"
              >
                <div className="max-h-[60vh] min-w-0 overflow-y-auto">
                  <table
                    className="border-collapse text-sm"
                    style={{ width: Math.max(totalTableWidth, 760), minWidth: 760 }}
                  >
                  <thead className="sticky top-0 z-10 bg-slate-100 text-left uppercase text-xs text-slate-600">
                    <tr>
                      {columns.map((column) => (
                        <th
                          key={column}
                          className="relative border-b border-slate-200 px-3 py-3 sm:px-4"
                          style={{ width: columnWidths[column] ?? 220, minWidth: 120 }}
                        >
                          <div className="pr-3 whitespace-nowrap">{column}</div>
                          <button
                            type="button"
                            aria-label={`Resize ${column}`}
                            onMouseDown={(event) => startColumnResize(event, column)}
                            className="absolute right-0 top-0 h-full w-2 cursor-col-resize bg-transparent hover:bg-blue-200"
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!records.length ? (
                      <tr>
                        <td className="px-4 py-6 text-slate-500" colSpan={Math.max(columns.length, 1)}>
                          Sem registros carregados.
                        </td>
                      </tr>
                    ) : (
                      records.map((row, index) => (
                        <tr key={`${index}-${String(row.id ?? "record")}`} className="odd:bg-white even:bg-slate-50">
                          {columns.map((column) => (
                            <td
                              key={`${index}-${column}`}
                              className="border-b border-slate-100 px-3 py-2.5 align-top sm:px-4 sm:py-3"
                              style={{ width: columnWidths[column] ?? 220, minWidth: 120 }}
                            >
                              <span className="block max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap">
                                {typeof row[column] === "object"
                                  ? JSON.stringify(row[column])
                                  : String(row[column] ?? "")}
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                </div>
              </div>

              {tableScrollState.showHint ? (
                <>
                  <div
                    className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-white to-transparent transition-opacity ${
                      tableScrollState.canScrollLeft ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <div
                    className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-white to-transparent transition-opacity ${
                      tableScrollState.canScrollRight ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </>
              ) : null}
            </div>
          ) : (
            <pre className="mt-5 max-h-[620px] overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5">
              {records.length
                ? JSON.stringify(records, null, 2)
                : "[]\n// Carregue dados para visualizar o JSON"}
            </pre>
          )}
        </main>
      </div>
    </div>
  );
}
