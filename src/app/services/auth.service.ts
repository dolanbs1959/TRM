import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { tap, map, catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface RoofOptionCacheData {
  pitchOptions: string[];
  roofAreaOptions: string[];
  materialOptions: string[];
  typeOptions: string[];
  brandOptions: string[];
  colorOptions: string[];
}

export interface WorkflowLogPayload {
  eventType: string;
  eventTimestamp: string;
  gpsCoordinates: string;
  notes?: string;
  relatedEmployeeId: number;
}

export interface OfferedServiceItem {
  id: number;
  name: string;
  description: string;
  category: string;
  serviceType: string;
  unit: string;
  price: number;
  isPackage: boolean;
  packageTier: string;
  active: boolean;
  sortOrder: number;
  raw?: any;
}

export interface TaskPhoto {
  recordId: string;
  url: string;
}

export interface ServiceOrderTask {
  id: string;
  relatedServiceOrder: string;
  taskName: string;
  serviceCategory: string;
  quantity: number | null;
  description: string;
  specialInstructions: string;
  technicianInstructions: string;
  taskStatus: string;
  taskOrigin: string;
  beforePhotos: TaskPhoto[];
  afterPhotos: TaskPhoto[];
}

export interface ServiceOrderAssignment {
  recordId: string;
  serviceOrderId: string;
  technicianId: string;
  technicianName: string;
  assignmentStatus: string;
}

export interface EstimateSubmissionPayload {
  serviceOrderId: string;
  locationRecordId: string;
  locationEmail: string;
  customerRecordId?: string;
  roofRecordIds?: number[];
  submissionMode: 'estimated' | 'sold';
  customerReadyToBegin: boolean;
  digitalSignatureDataUrl: string;
  activeEstimateItems: Array<{
    id: number;
    description: string;
    qtyNeeded: number;
    sqFootage: number;
    price: number;
    lineSubtotal: number;
    specialInstructions?: string;
  }>;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  secondaryDiscountAmount: number;
  secondaryDiscountPercentage: number;
  discountControlValue?: string;
  isEstimateRevision?: boolean;
  inspectionPhotos?: Array<{
    src: string;
    section: string;
    notes: string;
  }>;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private static readonly STORAGE_KEY = 'trm.loggedInUser';
  private static readonly SCHEDULE_CACHE_KEY = 'trm.scheduleCache';
  private static readonly LOGIN_AT_KEY = 'trm.loginAtMs';
  private static readonly POST_BUFFER_REFRESH_AT_KEY = 'trm.postBufferRefreshAtMs';
  private static readonly ROOF_OPTIONS_CACHE_KEY = 'trm.roofOptionsCache';
  private static readonly LAST_ACTIVITY_KEY = 'trm.lastActivityMs';
  private static readonly SCHEDULE_REFRESH_BUFFER_MS = 15 * 60 * 1000;
  private static readonly SESSION_EXPIRATION_MS = 10 * 60 * 60 * 1000; // 10 hours

  private readonly apiBaseUrl = environment.apiUrl;
  
  private loggedInUser: any = null;
  private scheduleCache: Record<string, { cachedOn: string; data: any[] }> = {};
  private roofOptionsCache: { cachedOn: string; data: RoofOptionCacheData } | null = null;
  private loginAtMs: number | null = null;
  private postBufferRefreshAtMs: number | null = null;

  constructor(private http: HttpClient) {
    this.scheduleCache = this.readStoredScheduleCache();
    this.roofOptionsCache = this.readStoredRoofOptionsCache();
    this.loginAtMs = this.readStoredNumber(AuthService.LOGIN_AT_KEY);
    this.postBufferRefreshAtMs = this.readStoredNumber(AuthService.POST_BUFFER_REFRESH_AT_KEY);

    const storedUser = this.readStoredUser();
    if (storedUser && this.isSessionValid()) {
      this.loggedInUser = storedUser;
      this.updateActivityTimestamp();
    } else {
      this.clearExpiredSession();
    }
  }

  private emptyRoofOptionCacheData(): RoofOptionCacheData {
    return {
      pitchOptions: [],
      roofAreaOptions: [],
      materialOptions: [],
      typeOptions: [],
      brandOptions: [],
      colorOptions: [],
    };
  }

  private readStoredNumber(key: string): number | null {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private setLoginTimestamp(nowMs: number) {
    this.loginAtMs = nowMs;
    this.postBufferRefreshAtMs = null;
    localStorage.setItem(AuthService.LOGIN_AT_KEY, String(nowMs));
    localStorage.removeItem(AuthService.POST_BUFFER_REFRESH_AT_KEY);
  }

  private markPostBufferRefresh(nowMs: number) {
    this.postBufferRefreshAtMs = nowMs;
    localStorage.setItem(AuthService.POST_BUFFER_REFRESH_AT_KEY, String(nowMs));
  }

  private shouldForceScheduleRefreshAfterLoginBuffer() {
    if (!this.loginAtMs) {
      return false;
    }

    const hasExceededBuffer = Date.now() - this.loginAtMs >= AuthService.SCHEDULE_REFRESH_BUFFER_MS;
    if (!hasExceededBuffer) {
      return false;
    }

    return !this.postBufferRefreshAtMs || this.postBufferRefreshAtMs < this.loginAtMs;
  }

  private readStoredUser() {
    const raw = localStorage.getItem(AuthService.STORAGE_KEY);
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error('Failed to restore stored login session:', error);
      localStorage.removeItem(AuthService.STORAGE_KEY);
      return null;
    }
  }

  private persistUser(user: any) {
    try {
      localStorage.setItem(AuthService.STORAGE_KEY, JSON.stringify(user));
    } catch (error) {
      console.error('Failed to persist user session:', error);
    }
  }

  private updateActivityTimestamp() {
    const nowMs = Date.now();
    localStorage.setItem(AuthService.LAST_ACTIVITY_KEY, String(nowMs));
  }

  private isSessionValid(): boolean {
    const lastActivityMs = this.readStoredNumber(AuthService.LAST_ACTIVITY_KEY);
    if (!lastActivityMs) {
      return false;
    }

    const inactiveMs = Date.now() - lastActivityMs;
    return inactiveMs < AuthService.SESSION_EXPIRATION_MS;
  }

  hasValidSession(): boolean {
    const storedUser = this.readStoredUser();
    if (!storedUser) {
      return false;
    }
    return this.isSessionValid();
  }

  private clearExpiredSession() {
    this.loggedInUser = null;
    this.loginAtMs = null;
    localStorage.removeItem(AuthService.STORAGE_KEY);
    localStorage.removeItem(AuthService.LOGIN_AT_KEY);
    localStorage.removeItem(AuthService.LAST_ACTIVITY_KEY);
  }

  private readStoredScheduleCache() {
    const raw = localStorage.getItem(AuthService.SCHEDULE_CACHE_KEY);
    if (!raw) return {};

    try {
      const cache = JSON.parse(raw);
      const todayKey = this.getDateKey(new Date());
      const nextCache: Record<string, { cachedOn: string; data: any[] }> = {};

      Object.entries(cache).forEach(([key, entry]: any) => {
        if (entry?.cachedOn === todayKey) {
          nextCache[key] = entry;
        }
      });

      return nextCache;
    } catch (error) {
      console.error('Failed to restore stored schedule cache:', error);
      localStorage.removeItem(AuthService.SCHEDULE_CACHE_KEY);
      return {};
    }
  }

  private persistScheduleCache() {
    localStorage.setItem(AuthService.SCHEDULE_CACHE_KEY, JSON.stringify(this.scheduleCache));
  }

  private clearScheduleCache() {
    this.scheduleCache = {};
    localStorage.removeItem(AuthService.SCHEDULE_CACHE_KEY);
  }

  private readStoredRoofOptionsCache() {
    const raw = localStorage.getItem(AuthService.ROOF_OPTIONS_CACHE_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const data = parsed.data || {};
      return {
        cachedOn: String(parsed.cachedOn || ''),
        data: {
          pitchOptions: Array.isArray(data.pitchOptions) ? data.pitchOptions : [],
          roofAreaOptions: Array.isArray(data.roofAreaOptions) ? data.roofAreaOptions : [],
          materialOptions: Array.isArray(data.materialOptions) ? data.materialOptions : [],
          typeOptions: Array.isArray(data.typeOptions) ? data.typeOptions : [],
          brandOptions: Array.isArray(data.brandOptions) ? data.brandOptions : [],
          colorOptions: Array.isArray(data.colorOptions) ? data.colorOptions : [],
        },
      };
    } catch (error) {
      console.error('Failed to restore roof options cache:', error);
      localStorage.removeItem(AuthService.ROOF_OPTIONS_CACHE_KEY);
      return null;
    }
  }

  private persistRoofOptionsCache() {
    if (!this.roofOptionsCache) {
      localStorage.removeItem(AuthService.ROOF_OPTIONS_CACHE_KEY);
      return;
    }

    localStorage.setItem(AuthService.ROOF_OPTIONS_CACHE_KEY, JSON.stringify(this.roofOptionsCache));
  }

  private isRoofOptionsCacheFreshForToday() {
    return this.roofOptionsCache?.cachedOn === this.getDateKey(new Date());
  }

  async getRoofOptionCache(options?: { forceRefresh?: boolean }): Promise<RoofOptionCacheData> {
    const forceRefresh = !!options?.forceRefresh;
    if (!forceRefresh && this.roofOptionsCache && this.isRoofOptionsCacheFreshForToday()) {
      return this.roofOptionsCache.data;
    }

    const url = `${this.apiBaseUrl}/roofs/options`;

    try {
      const response: any = await this.http.post(url, {}).toPromise();
      if (response?.success) {
        const data: RoofOptionCacheData = {
          pitchOptions: Array.isArray(response?.data?.pitchOptions) ? response.data.pitchOptions : [],
          roofAreaOptions: Array.isArray(response?.data?.roofAreaOptions) ? response.data.roofAreaOptions : [],
          materialOptions: Array.isArray(response?.data?.materialOptions) ? response.data.materialOptions : [],
          typeOptions: Array.isArray(response?.data?.typeOptions) ? response.data.typeOptions : [],
          brandOptions: Array.isArray(response?.data?.brandOptions) ? response.data.brandOptions : [],
          colorOptions: Array.isArray(response?.data?.colorOptions) ? response.data.colorOptions : [],
        };

        this.roofOptionsCache = {
          cachedOn: this.getDateKey(new Date()),
          data,
        };
        this.persistRoofOptionsCache();
        return data;
      }
    } catch (error) {
      console.error('Fetch Roof Options Error:', error);
    }

    return this.roofOptionsCache?.data || this.emptyRoofOptionCacheData();
  }

  async refreshRoofOptionCache() {
    return this.getRoofOptionCache({ forceRefresh: true });
  }

  private getDateKey(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getScheduleCacheKey(techId: string, date?: string, role?: string) {
    const normalizedRole = (role || '').toString().trim().toLowerCase() || 'unknown';
    return `${techId}:${date || this.getDateKey(new Date())}:${normalizedRole}`;
  }

  private pruneStaleScheduleCache() {
    const todayKey = this.getDateKey(new Date());
    const nextCache: Record<string, { cachedOn: string; data: any[] }> = {};

    Object.entries(this.scheduleCache).forEach(([key, entry]) => {
      if (entry.cachedOn === todayKey) {
        nextCache[key] = entry;
      }
    });

    if (Object.keys(nextCache).length === Object.keys(this.scheduleCache).length) {
      return;
    }

    this.scheduleCache = nextCache;
    this.persistScheduleCache();
  }

async login(phone: string, pin: string) {
const localProxyUrl = `${this.apiBaseUrl}/login`;

try {
    const response: any = await this.http.post(localProxyUrl, { phone, pin }).toPromise();

    if (response && response.success) {
      this.loggedInUser = response.user;
  this.setLoginTimestamp(Date.now());
      this.persistUser(this.loggedInUser);
      this.updateActivityTimestamp();
      console.log('Handshake successful through Firebase Emulator.');
      // console.log('Employee Data Received:', JSON.stringify(this.loggedInUser, null, 2));
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.error('Emulator Connection Error:', error);
    return false;
  }
}

getSchedule(techId: number, date: string) {
  console.log('--- AUTH SERVICE EXECUTING HTTP CLIENT POST ---', { techId, date });
  return this.http.post<any[]>(`${this.apiBaseUrl}/get-schedule`, { techId, date }).pipe(
    tap((res) => console.log('--- AUTH SERVICE RAW NETWORK INTERCEPT ---', res)),
    map((res) => Array.isArray(res) ? res : []),
    catchError((error) => {
      console.error('Fetch Schedule Error:', error);
      return of([]);
    })
  );
}

async getJobDetail(recordId: string) {
  const url = `${this.apiBaseUrl}/job-detail`;

  try {
    const response: any = await this.http.post(url, { recordId }).toPromise();
    if (response?.success) {
      return response.data || null;
    }

    return null;
  } catch (error) {
    console.error('Fetch Job Detail Error:', error);
    return null;
  }
}

  async getOfferedServiceItems(serviceOrderId: string): Promise<OfferedServiceItem[]> {
    const url = `${this.apiBaseUrl}/estimate/offered-service-items`;

    try {
      const response: any = await this.http.post(url, { serviceOrderId }).toPromise();
      if (!response?.success || !Array.isArray(response?.data)) {
        return [];
      }

      return response.data.map((row: any) => ({
        id: Number.parseInt(row?.id, 10) || 0,
        name: String(row?.name || '').trim(),
        description: String(row?.description || '').trim(),
        category: String(row?.category || '').trim(),
        serviceType: String(row?.serviceType || '').trim(),
        unit: String(row?.unit || '').trim(),
        price: Number.isFinite(Number(row?.price)) ? Number(row.price) : 0,
        isPackage: !!row?.isPackage,
        packageTier: String(row?.packageTier || '').trim(),
        active: row?.active !== false,
        sortOrder: Number.isFinite(Number(row?.sortOrder)) ? Number(row.sortOrder) : 0,
        raw: row?.raw,
      })).filter((row: OfferedServiceItem) => !!row.name);
    } catch (error) {
      console.error('Fetch Offered Service Items Error:', error);
      return [];
    }
  }

  async getRoofsByLocation(locationId: string): Promise<any[]> {
    const url = `${this.apiBaseUrl}/roofs/query`;
    try {
      const response: any = await this.http.post(url, { locationId }).toPromise();
      return response?.success ? (response.data || []) : [];
    } catch (error) {
      console.error('Fetch Roofs Error:', error);
      return [];
    }
  }

  async saveRoof(
    locationId: string,
    roofData: {
      label: string;
      material: string;
      pitch: string;
      roofType: string;
      brand: string;
      color: string;
      sqft: string;
    }
  ): Promise<boolean> {
    const url = `${this.apiBaseUrl}/roofs/add`;
    try {
      const response: any = await this.http
        .post(url, { locationId, ...roofData })
        .toPromise();
      return response?.success === true;
    } catch (error) {
      console.error('Add Roof Error:', error);
      return false;
    }
  }

  updateRoof(payload: any) {
    console.log('--- AUTH SERVICE FORCING RAW MUTATION PAYLOAD PUSH ---', payload);
    return this.http.post<any>(`${this.apiBaseUrl}/roofs/update`, payload);
  }

  logout() {
    this.loggedInUser = null;
    this.loginAtMs = null;
    this.postBufferRefreshAtMs = null;
    localStorage.removeItem(AuthService.STORAGE_KEY);
    localStorage.removeItem(AuthService.LOGIN_AT_KEY);
    localStorage.removeItem(AuthService.POST_BUFFER_REFRESH_AT_KEY);
    localStorage.removeItem(AuthService.ROOF_OPTIONS_CACHE_KEY);
    localStorage.removeItem(AuthService.LAST_ACTIVITY_KEY);
    this.clearScheduleCache();
    this.roofOptionsCache = null;
  }

  clearLoginSession() {
    this.loggedInUser = null;
    localStorage.removeItem(AuthService.STORAGE_KEY);
    localStorage.removeItem(AuthService.LAST_ACTIVITY_KEY);
  }

  async clockInTimecard(techId: string | number, coordinates: string) {
    const url = `${this.apiBaseUrl}/timecard/clock-in`;
    const now = new Date();

    const response: any = await this.http.post(url, {
      employeeId: Number(techId),
      date: this.getDateKey(now),
      clockInTime: this.toTimeOfDay(now),
      clockInCoordinates: coordinates,
    }).toPromise();

    return response?.success ? String(response.recordId) : null;
  }

  async clockOutTimecard(recordId: string, coordinates: string) {
    const url = `${this.apiBaseUrl}/timecard/clock-out`;
    const now = new Date();

    const response: any = await this.http.post(url, {
      recordId,
      clockOutTime: this.toTimeOfDay(now),
      clockOutCoordinates: coordinates,
    }).toPromise();

    return !!response?.success;
  }

  async recordTimecardJobEvent(recordId: string, eventType: 'complete' | 'return_required') {
    const url = `${this.apiBaseUrl}/timecard/job-event`;
    const now = new Date();

    const response: any = await this.http.post(url, {
      recordId,
      eventType,
      eventAt: now.toISOString(),
    }).toPromise();

    return !!response?.success;
  }

  async updateServiceOrderStatus(recordId: string, _status: string, workflowLog?: WorkflowLogPayload, technicianContext?: { technicianName: string; technicianPhotoUrl: string }, workflowContext?: { customerFirstName: string; customerMobile: string; technicianFirstName: string; jobAddress?: string; jobLat?: number | null; jobLng?: number | null }) {
    const url = `${this.apiBaseUrl}/service-order/update-workflow`;
    const response: any = await this.http.post(url, {
      recordId,
      serviceOrderId: recordId,
      status: _status,
      techId: workflowLog?.relatedEmployeeId,
      workflowEventType: workflowLog?.eventType,
      workflowGpsCoordinates: workflowLog?.gpsCoordinates,
      workflowNotes: workflowLog?.notes || '',
      relatedEmployeeId: workflowLog?.relatedEmployeeId,
      technicianName: technicianContext?.technicianName || '',
      technicianPhotoUrl: technicianContext?.technicianPhotoUrl || '',
      customerFirstName: workflowContext?.customerFirstName || '',
      customerMobile: workflowContext?.customerMobile || '',
      technicianFirstName: workflowContext?.technicianFirstName || '',
      jobAddress: workflowContext?.jobAddress || '',
      jobLat: workflowContext?.jobLat ?? null,
      jobLng: workflowContext?.jobLng ?? null,
    }).toPromise();

    return !!response?.success;
  }

  async appendServiceOrderNote(recordId: string, _noteToAppend: string, workflowLog?: WorkflowLogPayload) {
    const url = `${this.apiBaseUrl}/service-order/update-workflow`;
    const response: any = await this.http.post(url, {
      recordId,
      serviceOrderId: recordId,
      noteToAppend: _noteToAppend,
      techId: workflowLog?.relatedEmployeeId,
      workflowEventType: workflowLog?.eventType,
      workflowGpsCoordinates: workflowLog?.gpsCoordinates,
      workflowNotes: workflowLog?.notes || '',
      relatedEmployeeId: workflowLog?.relatedEmployeeId,
    }).toPromise();

    return !!response?.success;
  }

  async submitInspectionData(payload: any): Promise<boolean> {
    const url = `${this.apiBaseUrl}/submit-inspection-data`;

    try {
      const response: any = await this.http
        .post(url, payload, { observe: 'response' })
        .toPromise();

      if (response?.status !== 200) {
        return false;
      }

      const body = response.body;
      if (body && typeof body === 'object' && 'success' in body) {
        return !!body.success;
      }

      return true;
    } catch (error) {
      console.error('Submit Inspection Data Error:', error);
      return false;
    }
  }

  async submitEstimateSubmission(payload: EstimateSubmissionPayload): Promise<{ success: boolean; message?: string; nextWorkflowAction?: string; insertedLineItemCount?: number }> {
    const url = `${this.apiBaseUrl}/estimate/submit`;

    try {
      const response: any = await this.http
        .post(url, payload, { observe: 'response' })
        .toPromise();

      if (response?.status !== 200) {
        return { success: false, message: `Unexpected response status ${response?.status || 'unknown'}` };
      }

      const body = response.body;
      if (body && typeof body === 'object') {
        return {
          success: !!body.success,
          message: body.message,
          nextWorkflowAction: body.nextWorkflowAction,
          insertedLineItemCount: body.insertedLineItemCount,
        };
      }

      return { success: false, message: 'Empty response from estimate submission endpoint' };
    } catch (error) {
      console.error('Submit Estimate Error:', error);
      return { success: false, message: 'Estimate submission request failed' };
    }
  }

  async retrieveEstimate(serviceOrderId: string): Promise<{ success: boolean; data?: any; message?: string }> {
    const url = `${this.apiBaseUrl}/estimate/retrieve/${serviceOrderId}`;
    try {
      const response: any = await this.http.get(url).toPromise();
      if (response && typeof response === 'object') {
        return {
          success: !!response.success,
          data: response.data,
          message: response.message,
        };
      }
      return { success: false, message: 'Empty response from estimate retrieval endpoint' };
    } catch (error) {
      console.error('Retrieve Estimate Error:', error);
      return { success: false, message: 'Estimate retrieval request failed' };
    }
  }

  private toTimeOfDay(date: Date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  getUser() {
    if (this.loggedInUser) {
      this.updateActivityTimestamp();
    }
    return this.loggedInUser;
  } 
// ... your existing login() or getUser() methods are up here ...


  // DROP IT RIGHT HERE:
async checkActiveTimecardSession(employeeId: any, dateStr: string) {
  console.log('> [PWA] ATTEMPTING FETCH TO:', `${environment.apiUrl}/timecard/active`);
  try {
    // Dynamically point to the URL defined in your environment files
    const url = `${environment.apiUrl}/timecard/active`; 
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, date: dateStr })
    });
          
      if (!response.ok) {
        console.error('> [Service Network Error] Status code returned:', response.status);
        return { shiftContext: { isClockedIn: false } };
      }
      
      return await response.json();
    } catch (err) {
      console.error('Failed to communicate with timecard active proxy endpoint:', err);
      return { shiftContext: { isClockedIn: false } };
    }
  }

  async uploadTaskPhoto(serviceOrderId: string, taskId: string, slot: 'before' | 'after', base64: string): Promise<TaskPhoto | null> {
    const url = `${this.apiBaseUrl}/service-order/task-photo/upload`;
    try {
      const response: any = await this.http.post(url, { serviceOrderId, taskId, slot, base64 }).toPromise();
      if (!response?.success) {
        return null;
      }
      return { recordId: String(response.recordId || ''), url: String(response.url || '') };
    } catch (error) {
      console.error('Upload Task Photo Error:', error);
      return null;
    }
  }

  async getServiceOrderTasks(serviceOrderId: string): Promise<ServiceOrderTask[]> {
    const url = `${this.apiBaseUrl}/service-order/tasks`;
    try {
      const response: any = await this.http.post(url, { serviceOrderId }).toPromise();
      if (!response?.success || !Array.isArray(response?.data)) {
        return [];
      }
      return response.data as ServiceOrderTask[];
    } catch (error) {
      console.error('Fetch Service Order Tasks Error:', error);
      return [];
    }
  }

  async updateServiceOrderTaskStatus(
    serviceOrderId: string,
    taskId: string,
    taskStatus: string
  ): Promise<boolean> {
    // Reuse the existing workflow endpoint rather than introducing a separate,
    // orphaned task-status route. The backend uses workflowEventType 'TaskComplete'
    // to update the Task table (bt73wgry8, Field ID 8) while keeping the parent
    // Service Order status unchanged.
    const user = this.getUser();
    const employeeId = user?.[3]?.value;
    const url = `${this.apiBaseUrl}/service-order/update-workflow`;
    const payload = {
      recordId: serviceOrderId,
      serviceOrderId,
      taskId,
      taskStatus,
      workflowEventType: 'TaskComplete',
      workflowNotes: `Task ${taskId} marked as ${taskStatus}`,
      techId: employeeId,
      relatedEmployeeId: employeeId,
    };
    console.log('[DIAG][TaskComplete] Workflow payload:', payload);
    try {
      const response: any = await this.http.post(url, payload).toPromise();
      return !!response?.success;
    } catch (error) {
      console.error('Update Service Order Task Status Error:', error);
      return false;
    }
  }

  async getServiceOrderAssignments(serviceOrderId: string): Promise<ServiceOrderAssignment[]> {
    const url = `${this.apiBaseUrl}/service-order/assignments`;
    try {
      const response: any = await this.http.post(url, { serviceOrderId }).toPromise();
      if (!response?.success || !Array.isArray(response?.data)) {
        return [];
      }
      return response.data as ServiceOrderAssignment[];
    } catch (error) {
      console.error('Fetch Service Order Assignments Error:', error);
      return [];
    }
  }

  async getHistoricalInspection(serviceOrderId: string): Promise<any | null> {
    const url = `${this.apiBaseUrl}/inspection/historical/${serviceOrderId}`;

    try {
      const response: any = await this.http.get(url).toPromise();
      if (response?.success && response?.data) {
        return response.data;
      }

      return null;
    } catch (error) {
      console.error('Fetch Historical Inspection Error:', error);
      return null;
    }
  }
}
