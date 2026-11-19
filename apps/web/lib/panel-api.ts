'use client';

import {
  AgenciesResponseSchema,
  CreateFaresResponseSchema,
  FareMatrixSchema,
  FareSchema,
  FaresResponseSchema,
  RouteSchema,
  RoutesResponseSchema,
  TraceImportResponseSchema,
  AgencySchema,
  BranchSchema,
  BranchesResponseSchema,
  LayoutAssignmentSchema,
  LayoutAssignmentsResponseSchema,
  LayoutSchema,
  LayoutVersionDetailSchema,
  LayoutsResponseSchema,
  LocationSchema,
  LocationsResponseSchema,
  SalesChannelSchema,
  SalesChannelsResponseSchema,
  VehicleDocumentFileSchema,
  VehicleDocumentSchema,
  VehicleDocumentsResponseSchema,
  VehicleSchema,
  VehicleTypeSchema,
  VehicleTypesResponseSchema,
  VehiclesResponseSchema,
  type CreateAgencyRequest,
  type CreateFaresRequest,
  type CreateRouteRequest,
  type FareService,
  type UpdateRouteRequest,
  type CreateBranchRequest,
  type CreateLayoutAssignmentRequest,
  type CreateLayoutRequest,
  type CreateVehicleRequest,
  type LayoutDocument,
  type LocationInput,
  type UpdateAgencyRequest,
  type UpdateBranchRequest,
  type UpdateLayoutRequest,
  type UpdateSalesChannelRequest,
  type UpdateVehicleRequest,
  type UpdateVehicleTypeRequest,
  type VehicleDocumentInput,
  type VehicleTypeInput,
} from '@yebo/contracts';
import { AuthRequestError, apiFetch, readCsrfCookie } from './auth-client';

/**
 * API del panel de la empresa para ubicaciones, flota y planos (Fase 6.4b), mismo origen y con el token CSRF. Cada
 * respuesta se valida con su contrato: si la API cambia, el panel falla aquí y no más adelante.
 */
type Schema<T> = { parse: (value: unknown) => T };

async function get<T>(schema: Schema<T>, path: string): Promise<T> {
  return schema.parse(await (await apiFetch(path)).json());
}

async function send<T>(
  schema: Schema<T>,
  path: string,
  body?: unknown,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const res = await apiFetch(path, {
    method,
    csrf: readCsrfCookie(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return schema.parse(await res.json());
}

// Ubicaciones, sucursales y canales (6.1)
export const locationsApi = {
  list: () => get(LocationsResponseSchema, '/api/v1/locations'),
  create: (input: LocationInput) => send(LocationSchema, '/api/v1/locations', input),
  update: (id: string, input: LocationInput) => send(LocationSchema, `/api/v1/locations/${id}`, input, 'PUT'),
  archive: (id: string) => send(LocationSchema, `/api/v1/locations/${id}/archive`),
  restore: (id: string) => send(LocationSchema, `/api/v1/locations/${id}/restore`),
  branches: () => get(BranchesResponseSchema, '/api/v1/branches'),
  createBranch: (input: CreateBranchRequest) => send(BranchSchema, '/api/v1/branches', input),
  updateBranch: (id: string, input: UpdateBranchRequest) =>
    send(BranchSchema, `/api/v1/branches/${id}`, input, 'PUT'),
  archiveBranch: (id: string) => send(BranchSchema, `/api/v1/branches/${id}/archive`),
  restoreBranch: (id: string) => send(BranchSchema, `/api/v1/branches/${id}/restore`),
  channels: () => get(SalesChannelsResponseSchema, '/api/v1/sales-channels'),
  updateChannel: (id: string, input: UpdateSalesChannelRequest) =>
    send(SalesChannelSchema, `/api/v1/sales-channels/${id}`, input, 'PUT'),
};

// Agencias externas (6.5), detrás del módulo AGENCIES
export const agenciesApi = {
  list: () => get(AgenciesResponseSchema, '/api/v1/agencies'),
  create: (input: CreateAgencyRequest) => send(AgencySchema, '/api/v1/agencies', input),
  update: (id: string, input: UpdateAgencyRequest) =>
    send(AgencySchema, `/api/v1/agencies/${id}`, input, 'PUT'),
  archive: (id: string) => send(AgencySchema, `/api/v1/agencies/${id}/archive`),
  restore: (id: string) => send(AgencySchema, `/api/v1/agencies/${id}/restore`),
};

// Flota (6.2) y asignación de planos (6.3)
export const fleetApi = {
  types: () => get(VehicleTypesResponseSchema, '/api/v1/vehicle-types'),
  createType: (input: VehicleTypeInput) => send(VehicleTypeSchema, '/api/v1/vehicle-types', input),
  updateType: (id: string, input: UpdateVehicleTypeRequest) =>
    send(VehicleTypeSchema, `/api/v1/vehicle-types/${id}`, input, 'PUT'),
  archiveType: (id: string) => send(VehicleTypeSchema, `/api/v1/vehicle-types/${id}/archive`),
  restoreType: (id: string) => send(VehicleTypeSchema, `/api/v1/vehicle-types/${id}/restore`),
  vehicles: () => get(VehiclesResponseSchema, '/api/v1/vehicles'),
  createVehicle: (input: CreateVehicleRequest) => send(VehicleSchema, '/api/v1/vehicles', input),
  updateVehicle: (id: string, input: UpdateVehicleRequest) =>
    send(VehicleSchema, `/api/v1/vehicles/${id}`, input, 'PUT'),
  documents: (vehicleId: string) =>
    get(VehicleDocumentsResponseSchema, `/api/v1/vehicles/${vehicleId}/documents`),
  createDocument: (vehicleId: string, input: VehicleDocumentInput) =>
    send(VehicleDocumentSchema, `/api/v1/vehicles/${vehicleId}/documents`, input),
  updateDocument: (vehicleId: string, documentId: string, input: VehicleDocumentInput) =>
    send(VehicleDocumentSchema, `/api/v1/vehicles/${vehicleId}/documents/${documentId}`, input, 'PUT'),
  archiveDocument: (vehicleId: string, documentId: string) =>
    send(VehicleDocumentSchema, `/api/v1/vehicles/${vehicleId}/documents/${documentId}/archive`),
  documentFileUrl: (vehicleId: string, documentId: string) =>
    `/api/v1/vehicles/${vehicleId}/documents/${documentId}/file`,
  assignments: (vehicleId: string) =>
    get(LayoutAssignmentsResponseSchema, `/api/v1/vehicles/${vehicleId}/layout-assignments`),
  assign: (vehicleId: string, input: CreateLayoutAssignmentRequest) =>
    send(LayoutAssignmentSchema, `/api/v1/vehicles/${vehicleId}/layout-assignments`, input),
  endAssignment: (vehicleId: string, assignmentId: string, validTo: string) =>
    send(LayoutAssignmentSchema, `/api/v1/vehicles/${vehicleId}/layout-assignments/${assignmentId}/end`, {
      validTo,
    }),
};

export const DOCUMENT_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

/** Sube el archivo de un documento (privado) y devuelve su id para referenciarlo en el documento. */
export async function uploadDocumentFile(file: File) {
  if (!(DOCUMENT_FILE_TYPES as readonly string[]).includes(file.type)) {
    throw new AuthRequestError(400, 'VALIDATION_FAILED', 'Usa un PDF, JPEG o PNG.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new AuthRequestError(413, 'PAYLOAD_TOO_LARGE', 'El archivo pesa más de 10 MB.');
  }
  const res = await apiFetch('/api/v1/vehicle-documents/files', {
    method: 'POST',
    csrf: readCsrfCookie(),
    body: file,
    headers: { 'Content-Type': file.type },
  });
  return VehicleDocumentFileSchema.parse(await res.json());
}

// Planos (6.3)
export const layoutsApi = {
  list: () => get(LayoutsResponseSchema, '/api/v1/layouts'),
  create: (input: CreateLayoutRequest) => send(LayoutVersionDetailSchema, '/api/v1/layouts', input),
  update: (id: string, input: UpdateLayoutRequest) =>
    send(LayoutSchema, `/api/v1/layouts/${id}`, input, 'PUT'),
  archive: (id: string) => send(LayoutSchema, `/api/v1/layouts/${id}/archive`),
  restore: (id: string) => send(LayoutSchema, `/api/v1/layouts/${id}/restore`),
  version: (id: string, version: number) =>
    get(LayoutVersionDetailSchema, `/api/v1/layouts/${id}/versions/${version}`),
  publish: (id: string) => send(LayoutVersionDetailSchema, `/api/v1/layouts/${id}/publish`),
  saveDraft: (id: string, document: LayoutDocument) =>
    send(LayoutVersionDetailSchema, `/api/v1/layouts/${id}/draft`, { document }, 'PUT'),
};

// Rutas (7.1) y tarifas (7.2)
export const routesApi = {
  list: () => get(RoutesResponseSchema, '/api/v1/routes'),
  create: (input: CreateRouteRequest) => send(RouteSchema, '/api/v1/routes', input),
  update: (id: string, input: UpdateRouteRequest) => send(RouteSchema, `/api/v1/routes/${id}`, input, 'PUT'),
  archive: (id: string) => send(RouteSchema, `/api/v1/routes/${id}/archive`),
  restore: (id: string) => send(RouteSchema, `/api/v1/routes/${id}/restore`),
};

/** Tipo del archivo de traza por su extensión (el navegador no siempre lo conoce). */
const TRACE_TYPES: Record<string, string> = {
  gpx: 'application/gpx+xml',
  kml: 'application/vnd.google-earth.kml+xml',
};

/** Lee un GPX o un KML en la API y devuelve la traza (ya simplificada) para revisarla; no guarda nada. */
export async function importTrace(file: File) {
  const type = TRACE_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''];
  if (!type) throw new AuthRequestError(400, 'VALIDATION_FAILED', 'Usa un archivo GPX o KML (no KMZ).');
  if (file.size > 5 * 1024 * 1024) {
    throw new AuthRequestError(413, 'PAYLOAD_TOO_LARGE', 'El archivo pesa más de 5 MB.');
  }
  const res = await apiFetch('/api/v1/routes/traces/import', {
    method: 'POST',
    csrf: readCsrfCookie(),
    body: file,
    headers: { 'Content-Type': type },
  });
  return TraceImportResponseSchema.parse(await res.json());
}

export const faresApi = {
  list: (routeId: string) => get(FaresResponseSchema, `/api/v1/routes/${routeId}/fares`),
  matrix: (routeId: string, service: FareService, date: string) =>
    get(FareMatrixSchema, `/api/v1/routes/${routeId}/fares/matrix?service=${service}&date=${date}`),
  create: (routeId: string, input: CreateFaresRequest) =>
    send(CreateFaresResponseSchema, `/api/v1/routes/${routeId}/fares`, input),
  end: (id: string, validTo: string) => send(FareSchema, `/api/v1/fares/${id}/end`, { validTo }),
  cancel: (id: string) => send(FareSchema, `/api/v1/fares/${id}/cancel`),
};
