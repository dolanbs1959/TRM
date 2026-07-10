import { Component, DoCheck, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { firstValueFrom } from 'rxjs';
import { AuthService, RoofOptionCacheData, ServiceOrderAssignment, ServiceOrderTask, WorkflowLogPayload } from '../services/auth.service';
import { LoadingService } from '../services/loading.service';
import { ServiceOrderCollaborationService } from '../services/service-order-collaboration.service';
import { environment } from '../../environments/environment';

type InspectionPhotoSectionKey =
  | 'penetrations'
  | 'fieldCondition'
  | 'ridgeCondition'
  | 'flashing'
  | 'boot'
  | 'vents'
  | 'ground';

interface InspectionPhotoAttachment {
  fileName: string;
  dataUrl: string;
  blob: Blob;
  notes: string;
  capturedAt: number;
  slot?: 'before' | 'after';
  taskId?: string;
  selected?: boolean;
}

interface PendingInspectionPhoto {
  sectionKey: InspectionPhotoSectionKey | null;
  taskId: string | null;
  taskSlot: 'before' | 'after' | null;
  dataUrl: string;
  blob: Blob;
  notes: string;
}

interface InspectionPhotoBatchRow {
  fid_6: InspectionPhotoSectionKey;
  fid_7: string;
  fid_8: string;
  fid_9: string;
}

interface InspectionSubmissionPayload {
  serviceOrderId: string;
  masterJobRecordValues: Record<string, string | number | boolean | null>;
  photoBatchData: {
    tableId: string;
    rows: InspectionPhotoBatchRow[];
  };
}

@Component({
  selector: 'app-job-detail',
  templateUrl: './job-detail.page.html',
  styleUrls: ['./job-detail.page.scss'],
  standalone: false,
})
export class JobDetailPage implements OnInit, DoCheck {
  private static readonly ACTIVE_JOB_ID_STORAGE_KEY = 'trm.activeJobId';
  private static readonly ACTIVE_JOB_MODE_STORAGE_KEY = 'trm.activeJobMode';
  private static readonly ACTIVE_JOB_SERVICE_ORDER_VIEW_STORAGE_KEY = 'trm.activeJobServiceOrderView';
  private static readonly ACTIVE_JOB_PAUSED_STORAGE_KEY = 'trm.activeJobPaused';
  private static readonly INSPECTION_CACHE_PREFIX = 'trm.inspectionCache.';
  private static readonly INSPECTION_DRAFT_DB_NAME = 'trmInspectionDraftDb';
  private static readonly INSPECTION_DRAFT_DB_VERSION = 1;
  private static readonly INSPECTION_PHOTO_STORE_NAME = 'inspectionPhotoDrafts';

  isLoading = true;
  job: any = null;
  activeJobId = '';
  pageMode: 'view' | 'work' = 'view';
  serviceOrderView: 'hub' | 'wrapup' = 'hub';
  isPausedWorkflow = false;
  inspectionHubSegment: 'checklist' | 'notes' = 'checklist';

  // Lead Tech Wrap-Up constants
  private static readonly WRAPUP_DRAFT_STORAGE_KEY_PREFIX = 'trm_wrapup_draft_';

  // Service Order Tasks state
  serviceTasks: ServiceOrderTask[] = [];
  serviceTasksLoading = false;
  isRefreshingCollaboration = false;

  // Service Order Assignments state (for Lead Tech Wrap-Up submit gate)
  serviceOrderAssignments: ServiceOrderAssignment[] = [];
  serviceOrderAssignmentsLoading = false;
  taskPhotoState: Record<string, InspectionPhotoAttachment[]> = {};
  finishedTaskIds: Set<string> = new Set();
  taskNotes: Record<string, string> = {};
  viewingPhoto: InspectionPhotoAttachment | null = null;
  selectedWrapUpPhotoIds: Set<string> = new Set();

  // Roof structures state
  roofs: any[] = [];
  roofsLoading = false;
  selectedRoofObj: any = null;
  editingRoof: any = null;
  showAddModal = false;
  isRefreshingRoofData = false;
  roofDataRefreshMessage = '';

  editForm = { material: '', pitch: '', roofType: '', brand: '', color: '', sqft: '' };
  addForm  = { label: '', material: '', pitch: '', roofType: '', brand: '', color: '', sqft: '' };

  materialOptions: string[] = [];
  pitchOptions: string[] = [];
  roofAreaOptions: string[] = [];
  roofTypeOptions: string[] = [];
  roofBrandOptions: string[] = [];
  roofColorOptions: string[] = [];
  readonly ROOF_STATUS_OPTIONS = ['Active', 'Inspection Complete', 'Needs Review'];

  readonly flashingsOptions = ['Chimney', 'Gutter', 'Roof to Wall', 'Skylight', 'Step', 'Valley Metal', 'None of the above'];
  readonly penetrationsOptions = ['Active', 'Field', 'Past', 'Ridge', 'None of the above'];
  readonly fieldConditionOptions = ['Good', 'Fair', 'Poor', 'Failing', 'None of the above'];
  readonly ridgeConditionOptions = ['Good', 'Fair', 'Poor', 'Failing', 'None of the above'];
  groundInspectionItems: Array<{ id: number; name: string; state: 0 | 1 | 2 }> = [
    { id: 1, name: 'Fascia & Soffit', state: 0 },
    { id: 2, name: 'Gutters', state: 0 },
    { id: 3, name: 'Downspouts & Extensions', state: 0 },
    { id: 4, name: 'Siding/Exterior Walls', state: 0 },
    { id: 5, name: 'Doors & Windows', state: 0 },
    { id: 6, name: 'Foundation/Grading', state: 0 },
    { id: 7, name: 'Driveway/Walkway', state: 0 },
    { id: 8, name: 'Perimeter Safety Hazards', state: 0 },
  ];

  inspectionPhotoState: Record<InspectionPhotoSectionKey, InspectionPhotoAttachment[]> = {
    penetrations: [],
    fieldCondition: [],
    ridgeCondition: [],
    flashing: [],
    boot: [],
    vents: [],
    ground: [],
  };

  isCapturingPhoto = false;
  isPhotoPreviewOpen = false;
  pendingPhotoPreview: PendingInspectionPhoto | null = null;
  isCompletingInspection = false;
  private lastDraftSnapshot = '';
  private lastPhotoDraftSnapshot = '';

  inspectionForm = {
    flashingsNeedingService: [] as string[],
    penetrationsLeaks: '',
    fieldCondition: '',
    ridgeCondition: '',
    bootsNeeded: false,
    bootQty15: '',
    bootQty2: '',
    bootQty3: '',
    ventsNeeded: false,
    af50VentQty: '',
    bf4VentQty: '',
    bf6VentQty: '',
    inspectionNotes: '',
  };

  // Lead Tech Wrap-Up state
  private lastWrapUpDraftSnapshot = '';
  private skipWrapUpDraftPersistence = false;
  wrapUpForm = {
    leadTechnician: '',
    crewMembers: '',
    arrivalTime: '',
    completionTime: '',
    prepWalkthroughDone: false,
    prepNotes: '',
    itemsMoved: '',
    itemsTarped: '',
    serviceCheckComplete: false,
    serviceCheckNotes: '',
    cleanupComplete: false,
    cleanupNotes: '',
    allServicesCompleted: false,
    servicesCompletedNotes: '',
    customerPresent: false,
    customerName: '',
    customerContact: '',
    customerApproved: false,
    approvalMethod: '',
    customerNotes: '',
    internalNotes: '',
  };

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService,
    private loadingService: LoadingService,
    private collaborationService: ServiceOrderCollaborationService
  ) {}

  private get serviceOrderId(): string {
    return (this.activeJobId || '').toString().trim();
  }

  private getInspectionDraftStorageKey(): string {
    const storageKey = `trm_inspection_draft_${this.serviceOrderId}`;
    return storageKey;
  }

  async ngOnInit() {
    const routeJobId = this.route.snapshot.paramMap.get('jobId') || '';
    const storedJobId = localStorage.getItem(JobDetailPage.ACTIVE_JOB_ID_STORAGE_KEY) || '';
    const resolvedJobId = routeJobId || storedJobId;

    const routeMode = this.normalizeMode(this.route.snapshot.queryParamMap.get('mode') || '');
    const storedMode = this.normalizeMode(
      localStorage.getItem(JobDetailPage.ACTIVE_JOB_MODE_STORAGE_KEY) || ''
    );
    this.pageMode = routeMode || storedMode || 'view';

    const routeServiceOrderView = this.normalizeServiceOrderView(
      this.route.snapshot.queryParamMap.get('view') || ''
    );
    const storedServiceOrderView = this.normalizeServiceOrderView(
      localStorage.getItem(JobDetailPage.ACTIVE_JOB_SERVICE_ORDER_VIEW_STORAGE_KEY) || ''
    );
    this.serviceOrderView = routeServiceOrderView || storedServiceOrderView || 'hub';

    const routePaused = this.normalizePaused(this.route.snapshot.queryParamMap.get('paused') || '');
    const storedPaused = this.normalizePaused(
      localStorage.getItem(JobDetailPage.ACTIVE_JOB_PAUSED_STORAGE_KEY) || ''
    );
    this.isPausedWorkflow = routePaused ?? storedPaused ?? false;

    if (!resolvedJobId) {
      this.router.navigate(['/home']);
      return;
    }

    this.activeJobId = resolvedJobId;
    localStorage.setItem(JobDetailPage.ACTIVE_JOB_ID_STORAGE_KEY, resolvedJobId);
    localStorage.setItem(JobDetailPage.ACTIVE_JOB_MODE_STORAGE_KEY, this.pageMode);
    localStorage.setItem(
      JobDetailPage.ACTIVE_JOB_SERVICE_ORDER_VIEW_STORAGE_KEY,
      this.serviceOrderView
    );
    localStorage.setItem(
      JobDetailPage.ACTIVE_JOB_PAUSED_STORAGE_KEY,
      this.isPausedWorkflow ? '1' : '0'
    );

    await this.loadJobDetail();
  }

  ngDoCheck() {
    this.persistInspectionDraftIfChanged();
    this.persistWrapUpDraftIfChanged();
  }

  private normalizeMode(value: string): 'view' | 'work' | null {
    const mode = (value || '').toString().trim().toLowerCase();
    if (mode === 'view' || mode === 'work') {
      return mode;
    }

    return null;
  }

  private normalizeServiceOrderView(value: string): 'hub' | 'wrapup' | null {
    const view = (value || '').toString().trim().toLowerCase();
    if (view === 'hub' || view === 'wrapup') {
      return view;
    }

    return null;
  }

  private normalizePaused(value: string): boolean | null {
    const normalizedValue = (value || '').toString().trim().toLowerCase();
    if (normalizedValue === '1' || normalizedValue === 'true' || normalizedValue === 'yes') {
      return true;
    }

    if (normalizedValue === '0' || normalizedValue === 'false' || normalizedValue === 'no') {
      return false;
    }

    return null;
  }

  async loadJobDetail() {
    this.isLoading = true;
    this.job = await this.authService.getJobDetail(this.activeJobId);
    this.isLoading = false;

    if (!this.job) {
      console.warn('Job detail not found for record id:', this.activeJobId);
      return;
    }

    if (this.isInspection()) {
      this.initializeInspectionForm();
      await this.hydrateInspectionDraftIfPresent();
      await this.loadRoofReferenceData();
      await this.loadRoofs();
      this.persistInspectionDraftIfChanged();
    }

    if (this.isServiceOrder()) {
      await this.loadServiceOrderTasks();

      if (this.serviceOrderView === 'wrapup') {
        if (!this.canAccessWrapUp()) {
          console.warn('[WrapUp] Access denied after load: redirecting to dashboard.', {
            serviceOrderId: this.serviceOrderId,
            isLead: this.isLeadTechnician(),
          });
          this.router.navigate(['/home']);
          return;
        }
        this.initializeWrapUpForm();
        await this.hydrateWrapUpDraftIfPresent();
        this.persistWrapUpDraftIfChanged();
        void this.loadServiceOrderAssignments();
      }
    }
  }

  onTaskNoteChange(taskId: string, value: string) {
    if (this.isHubInputLocked()) {
      return;
    }
    this.taskNotes[taskId] = value;
    this.collaborationService.updateTaskNote(this.serviceOrderId, taskId, value)
      .catch(err => console.warn('[TaskNotes] Firestore write failed:', err));
  }

  markTaskFinished(taskId: string) {
    if (this.isHubInputLocked()) {
      return;
    }
    this.finishedTaskIds.add(taskId);
    this.collaborationService.updateTaskFinished(this.serviceOrderId, taskId, true)
      .catch(err => console.warn('[TaskFinished] Firestore write failed:', err));
    void this.authService.updateServiceOrderTaskStatus(this.serviceOrderId, taskId, 'Completed')
      .then((didUpdate: boolean) => {
        if (!didUpdate) {
          console.warn('[TaskFinished] Backend task status update failed.', { taskId });
        }
      });
  }

  isTaskFinished(taskId: string): boolean {
    return this.finishedTaskIds.has(taskId);
  }

  async loadServiceOrderTasks() {
    this.serviceTasksLoading = true;
    this.serviceTasks = await this.authService.getServiceOrderTasks(this.serviceOrderId);
    await this.loadServiceOrderCollaborationData();
    this.serviceTasksLoading = false;
  }

  async loadServiceOrderAssignments() {
    if (!this.serviceOrderId) {
      return;
    }
    this.serviceOrderAssignmentsLoading = true;
    this.serviceOrderAssignments = await this.authService.getServiceOrderAssignments(this.serviceOrderId);
    this.serviceOrderAssignmentsLoading = false;
  }

  private async loadServiceOrderCollaborationData() {
    // Restore finished task state from Firestore session
    try {
      const ids = await this.collaborationService.getSessionFinishedTaskIds(this.serviceOrderId);
      this.finishedTaskIds = new Set(ids);
    } catch {
      this.finishedTaskIds = new Set();
    }
    // Restore task notes from Firestore session
    try {
      const notesFromFirestore = await this.collaborationService.getSessionTaskNotes(this.serviceOrderId);
      this.taskNotes = notesFromFirestore;
      console.log('[Collaboration][Load] Task notes restored from Firestore.', {
        serviceOrderId: this.serviceOrderId,
        taskNoteCount: Object.keys(notesFromFirestore).length,
        taskNotes: notesFromFirestore,
      });
    } catch {
      this.taskNotes = {};
    }
    // Hydrate taskPhotoState from Firestore session — use Storage URL as dataUrl for cross-device display
    this.taskPhotoState = {};
    try {
      const firestorePhotos = await this.collaborationService.getSessionTaskPhotos(this.serviceOrderId);
      for (const [slotKey, photoMetas] of Object.entries(firestorePhotos)) {
        // slotKey format: "before-<taskId>" or "after-<taskId>"
        const [slot, ...taskIdParts] = slotKey.split('-');
        const taskId = taskIdParts.join('-');
        this.taskPhotoState[slotKey] = photoMetas.map(m => ({
          fileName: m.fileName,
          dataUrl: m.storageUrl || '',
          blob: new Blob([]),
          notes: m.notes,
          capturedAt: m.capturedAt,
          slot: (slot === 'before' || slot === 'after' ? slot : undefined) as 'before' | 'after' | undefined,
          taskId,
        }));
      }
      const photoNoteSamples: Record<string, { fileName: string; notes: string }[]> = {};
      for (const [key, photos] of Object.entries(this.taskPhotoState).slice(0, 2)) {
        photoNoteSamples[key] = photos.map(p => ({ fileName: p.fileName, notes: p.notes }));
      }
      console.log('[Collaboration][Load] Task photos restored from Firestore.', {
        serviceOrderId: this.serviceOrderId,
        slotCount: Object.keys(this.taskPhotoState).length,
        photoNoteSamples,
      });
    } catch {
      this.taskPhotoState = {};
    }
  }

  async refreshCollaborationData() {
    if (!this.isServiceOrder() || !this.serviceOrderId) {
      return;
    }
    this.isRefreshingCollaboration = true;
    try {
      await this.loadServiceOrderCollaborationData();
      if (this.serviceOrderView === 'wrapup') {
        await this.loadServiceOrderAssignments();
        console.log('[WrapUp][Refresh] Submit eligibility re-evaluated.', {
          serviceOrderId: this.serviceOrderId,
          assignments: this.serviceOrderAssignments.map(a => ({
            id: a.recordId,
            status: a.assignmentStatus,
          })),
          allAssignmentsCompleted: this.isAllTechnicianAssignmentsCompleted(),
          isSubmitEnabled: this.isSubmitWrapUpEnabled(),
        });
      }
    } catch (err) {
      console.warn('[Collaboration] Refresh failed:', err);
    } finally {
      this.isRefreshingCollaboration = false;
    }
  }

  getTaskPhotoAttachments(taskId: string, slot: 'before' | 'after'): InspectionPhotoAttachment[] {
    return this.taskPhotoState[`${slot}-${taskId}`] || [];
  }

  openPhotoViewer(photo: InspectionPhotoAttachment) {
    this.viewingPhoto = photo;
  }

  closePhotoViewer() {
    this.viewingPhoto = null;
  }

  async deleteTaskPhoto(taskId: string, slot: 'before' | 'after', fileName: string) {
    if (this.isHubInputLocked()) {
      return;
    }

    const slotKey = `${slot}-${taskId}`;
    const attachments = this.taskPhotoState[slotKey] || [];
    const target = attachments.find((p) => p.fileName === fileName);
    if (!target) {
      return;
    }

    // Optimistically remove from local state.
    this.taskPhotoState[slotKey] = attachments.filter((p) => p.fileName !== fileName);

    try {
      await this.collaborationService.deleteTaskPhoto(this.serviceOrderId, taskId, slot, fileName);
      console.log('[TaskPhotos] Deleted shared task photo.', { taskId, slot, fileName });
    } catch (err) {
      console.warn('[TaskPhotos] Failed to delete shared task photo. Restoring local state.', err);
      // Restore the local entry on failure so the user can retry.
      this.taskPhotoState[slotKey] = [...(this.taskPhotoState[slotKey] || []), target];
    }
  }

  async beginTaskPhotoCapture(taskId: string, slot: 'before' | 'after', event?: Event) {
    console.log('[DIAG] beginTaskPhotoCapture() called', { taskId, slot });
    event?.preventDefault();
    event?.stopPropagation();

    if (this.isHubInputLocked() || this.isCapturingPhoto) {
      return;
    }

    try {
      this.isCapturingPhoto = true;
      const photo = await Camera.getPhoto({
        quality: 85,
        width: 1920,
        height: 1920,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
      });

      if (!photo?.dataUrl) {
        console.log('[DIAG] beginTaskPhotoCapture() — no dataUrl returned from camera');
        return;
      }

      const optimizedDataUrl = await this.optimizePhotoDataUrl(photo.dataUrl);
      const photoBlob = await this.dataUrlToBlob(optimizedDataUrl);
      console.log('[DIAG] beginTaskPhotoCapture() — pendingPhotoPreview set', { taskId, slot, blobSize: photoBlob?.size });
      this.pendingPhotoPreview = {
        sectionKey: null,
        taskId,
        taskSlot: slot,
        dataUrl: optimizedDataUrl,
        blob: photoBlob,
        notes: '',
      };
      this.isPhotoPreviewOpen = true;
    } catch (error: any) {
      const message = (error?.message || '').toString().toLowerCase();
      if (message.includes('cancel')) {
        console.log('[DIAG] beginTaskPhotoCapture() — user cancelled camera');
        return;
      }
      console.warn('[DIAG] beginTaskPhotoCapture() catch:', error);
    } finally {
      this.isCapturingPhoto = false;
    }
  }

  private migrateFlashingData(data: string | string[]): string[] {
    if (Array.isArray(data)) {
      return data;
    }
    if (typeof data === 'string' && data.trim() !== '') {
      return data.split(';').map(item => item.trim()).filter(item => item !== '');
    }
    return [];
  }

  private initializeInspectionForm() {
    this.inspectionForm = {
      flashingsNeedingService: this.migrateFlashingData(this.getFieldValue(153) || this.getFieldValue(47)),
      penetrationsLeaks: this.getFieldValue(48),
      fieldCondition: this.getFieldValue(49),
      ridgeCondition: this.getFieldValue(50),
      bootsNeeded: this.getTruthyFieldValue(51),
      bootQty15: this.getNumericFieldValue(52),
      bootQty2: this.getNumericFieldValue(56),
      bootQty3: this.getNumericFieldValue(57),
      ventsNeeded: this.getTruthyFieldValue(55),
      af50VentQty: this.getNumericFieldValue(53),
      bf4VentQty: this.getNumericFieldValue(59),
      bf6VentQty: this.getNumericFieldValue(58),
      inspectionNotes: this.getFieldValue(10),
    };
  }

  private getTruthyFieldValue(fid: number): boolean {
    const value = this.getFieldValue(fid).toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'checked';
  }

  private getNumericFieldValue(fid: number): string {
    return this.getFieldValue(fid);
  }

  private getFallbackRoofOptions(): RoofOptionCacheData {
    return {
      pitchOptions: ['2/12', '3/12', '4/12', '5/12', '6/12', '7/12', '8/12', '9/12', '10/12', '12/12'],
      roofAreaOptions: [],
      materialOptions: ['Composition', 'Tile', 'Torch', 'Metal'],
      typeOptions: [],
      brandOptions: [],
      colorOptions: [],
    };
  }

  private applyRoofReferenceData(data: RoofOptionCacheData) {
    const fallback = this.getFallbackRoofOptions();

    this.pitchOptions = data.pitchOptions?.length ? data.pitchOptions : fallback.pitchOptions;
    this.roofAreaOptions = data.roofAreaOptions || [];
    this.materialOptions = data.materialOptions?.length ? data.materialOptions : fallback.materialOptions;
    this.roofTypeOptions = data.typeOptions || [];
    this.roofBrandOptions = data.brandOptions || [];
    this.roofColorOptions = data.colorOptions || [];
  }

  async loadRoofReferenceData(forceRefresh = false) {
    try {
      let data = forceRefresh
        ? await this.authService.refreshRoofOptionCache()
        : await this.authService.getRoofOptionCache();

      // Recover from stale same-day cache entries that predate roofAreaOptions.
      if (!forceRefresh && (!Array.isArray(data.roofAreaOptions) || data.roofAreaOptions.length === 0)) {
        data = await this.authService.refreshRoofOptionCache();
      }

      this.applyRoofReferenceData(data);
    } catch (error) {
      console.warn('Roof reference data load failed. Using fallback options.', error);
      this.applyRoofReferenceData(this.getFallbackRoofOptions());
    }
  }

  async refreshRoofData(event?: Event) {
    event?.stopPropagation();
    if (this.isRefreshingRoofData) {
      return;
    }

    this.isRefreshingRoofData = true;
    this.roofDataRefreshMessage = '';
    try {
      await this.loadRoofReferenceData(true);
      await this.loadRoofs();
      this.roofDataRefreshMessage = 'Roof data refreshed from server.';
    } catch (error) {
      console.warn('Manual roof data refresh failed:', error);
      this.roofDataRefreshMessage = 'Roof data refresh failed. Using cached values.';
    } finally {
      this.isRefreshingRoofData = false;
    }
  }

  goBack() {
    this.router.navigate(['/home']);
  }

  getStage() {
    return (this.job?.['40']?.value || '').toString().trim().toLowerCase();
  }

  isInspection() {
    return this.getStage() === 'inspection';
  }

  /** True only when the job stage is explicitly "service order". */
  isServiceOrder() {
    return this.getStage() === 'service order';
  }

  isReadOnlyMode() {
    return this.pageMode === 'view';
  }

  isWrapUpView() {
    return this.serviceOrderView === 'wrapup';
  }

  isServiceOrderHub() {
    return this.isServiceOrder() && this.serviceOrderView === 'hub';
  }

  isLeadTechnician(): boolean {
    const user = this.authService.getUser();
    const role = (
      user?.role ||
      user?.employeeRole ||
      user?.['17']?.value ||
      ''
    ).toString().trim().toLowerCase();
    const isLead = role.includes('lead');
    console.log('[DIAG][JobDetail][isLeadTechnician]', {
      hasUser: !!user,
      roleProp: user?.role,
      employeeRoleProp: user?.employeeRole,
      field17: user?.['17']?.value,
      computedRole: role,
      isLead,
    });
    return isLead;
  }

  canAccessWrapUp(): boolean {
    return this.isServiceOrder() && this.isLeadTechnician();
  }

  isHubInputLocked() {
    return this.isReadOnlyMode() || this.isPausedWorkflow;
  }

  getModeLabel() {
    if (this.isReadOnlyMode()) {
      return 'READ ONLY';
    }

    return this.isPausedWorkflow ? 'WORKFLOW PAUSED' : 'WORKFLOW MODE';
  }

  getFieldValue(fid: number) {
    return (this.job?.[String(fid)]?.value || '').toString().trim();
  }

  getCustomerName() {
    const firstName = (this.job?.['93']?.value || '').toString().trim();
    const lastName = (this.job?.['94']?.value || '').toString().trim();
    const fullName = `${firstName} ${lastName}`.trim();
    return fullName || 'Customer';
  }

  getCustomerAddressLine() {
    const streetNumber = (this.job?.['106']?.value || '').toString().trim();
    const streetName = (this.job?.['107']?.value || '').toString().trim();
    const city = (this.job?.['92']?.value || '').toString().trim();
    const state = (this.job?.['105']?.value || '').toString().trim();

    const streetLine = [streetNumber, streetName].filter(Boolean).join(' ');
    return [streetLine, city, state].filter(Boolean).join(', ');
  }
      openInGoogleMaps() {
      const address = this.getCustomerAddressLine();
      if (!address) {
        return;
      }

      window.open(
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
        '_blank'
      );
    }
    getSatelliteImageUrl(): string {
      const address = this.getCustomerAddressLine();

      if (!address) {
        return '';
      }

      return `${environment.apiUrl}/satellite-image?address=${encodeURIComponent(address)}`;
    }
    getLocationName() {
      return (this.job?.['90']?.value || '').toString().trim();
    }

  getCustomerPhone() {
    return (this.job?.['95']?.value || this.job?.['96']?.value || '').toString().trim();
  }

  // --- Lead Tech Wrap-Up methods ---

  private getWrapUpDraftStorageKey(): string {
    return `${JobDetailPage.WRAPUP_DRAFT_STORAGE_KEY_PREFIX}${this.serviceOrderId}`;
  }

  private initializeWrapUpForm() {
    this.skipWrapUpDraftPersistence = true;
    const user = this.authService.getUser();
    const leadName = `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
    this.wrapUpForm = {
      ...this.wrapUpForm,
      leadTechnician: leadName || this.wrapUpForm.leadTechnician,
      customerName: this.getCustomerName() || this.wrapUpForm.customerName,
      customerContact: this.getCustomerPhone() || this.wrapUpForm.customerContact,
      completionTime: this.getCurrentTimeInputValue(),
    };
    this.skipWrapUpDraftPersistence = false;
  }

  private getCurrentTimeInputValue(): string {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  getAllTaskBeforePhotos(): InspectionPhotoAttachment[] {
    const photos: InspectionPhotoAttachment[] = [];
    for (const task of this.serviceTasks) {
      photos.push(...this.getTaskPhotoAttachments(task.id, 'before'));
    }
    return photos;
  }

  getAllTaskAfterPhotos(): InspectionPhotoAttachment[] {
    const photos: InspectionPhotoAttachment[] = [];
    for (const task of this.serviceTasks) {
      photos.push(...this.getTaskPhotoAttachments(task.id, 'after'));
    }
    return photos;
  }

  private getWrapUpPhotoSelectionId(photo: InspectionPhotoAttachment): string {
    return `${photo.slot || 'unknown'}-${photo.taskId || 'unknown'}-${photo.fileName}`;
  }

  isWrapUpPhotoSelected(photo: InspectionPhotoAttachment): boolean {
    return this.selectedWrapUpPhotoIds.has(this.getWrapUpPhotoSelectionId(photo));
  }

  toggleWrapUpPhotoSelection(photo: InspectionPhotoAttachment, event?: Event): void {
    event?.stopPropagation();
    const id = this.getWrapUpPhotoSelectionId(photo);
    if (this.selectedWrapUpPhotoIds.has(id)) {
      this.selectedWrapUpPhotoIds.delete(id);
    } else {
      this.selectedWrapUpPhotoIds.add(id);
    }
  }

  selectAllWrapUpPhotos(slot?: 'before' | 'after'): void {
    const photos = slot === 'before'
      ? this.getAllTaskBeforePhotos()
      : slot === 'after'
        ? this.getAllTaskAfterPhotos()
        : [...this.getAllTaskBeforePhotos(), ...this.getAllTaskAfterPhotos()];
    for (const photo of photos) {
      this.selectedWrapUpPhotoIds.add(this.getWrapUpPhotoSelectionId(photo));
    }
  }

  clearAllWrapUpPhotoSelections(slot?: 'before' | 'after'): void {
    if (!slot) {
      this.selectedWrapUpPhotoIds.clear();
      return;
    }
    const ids = (slot === 'before' ? this.getAllTaskBeforePhotos() : this.getAllTaskAfterPhotos())
      .map(p => this.getWrapUpPhotoSelectionId(p));
    for (const id of ids) {
      this.selectedWrapUpPhotoIds.delete(id);
    }
  }

  getSelectedWrapUpPhotoCount(slot?: 'before' | 'after'): number {
    const photos = slot === 'before'
      ? this.getAllTaskBeforePhotos()
      : slot === 'after'
        ? this.getAllTaskAfterPhotos()
        : [...this.getAllTaskBeforePhotos(), ...this.getAllTaskAfterPhotos()];
    return photos.filter(p => this.isWrapUpPhotoSelected(p)).length;
  }

  getFinishedTaskCount(): number {
    return this.serviceTasks.filter(t => this.isTaskFinished(t.id)).length;
  }

  enterWrapUpMode() {
    if (!this.canAccessWrapUp()) {
      return;
    }
    this.pageMode = 'work';
    this.serviceOrderView = 'wrapup';
    localStorage.setItem(JobDetailPage.ACTIVE_JOB_MODE_STORAGE_KEY, 'work');
    localStorage.setItem(JobDetailPage.ACTIVE_JOB_SERVICE_ORDER_VIEW_STORAGE_KEY, 'wrapup');
    this.initializeWrapUpForm();
    void this.hydrateWrapUpDraftIfPresent().then(() => {
      this.persistWrapUpDraftIfChanged();
    });
  }

  enterWorkMode() {
    this.pageMode = 'work';
    this.serviceOrderView = 'hub';
    localStorage.setItem(JobDetailPage.ACTIVE_JOB_MODE_STORAGE_KEY, 'work');
    localStorage.setItem(JobDetailPage.ACTIVE_JOB_SERVICE_ORDER_VIEW_STORAGE_KEY, 'hub');
  }

  private buildWrapUpDraftData() {
    return {
      serviceOrderId: this.serviceOrderId,
      wrapUpForm: { ...this.wrapUpForm },
    };
  }

  private persistWrapUpDraftIfChanged() {
    if (this.skipWrapUpDraftPersistence || !this.isWrapUpView() || !this.serviceOrderId) {
      return;
    }

    try {
      const currentData = this.buildWrapUpDraftData();
      const serialized = JSON.stringify(currentData);
      if (!serialized || serialized === this.lastWrapUpDraftSnapshot) {
        return;
      }

      localStorage.setItem(this.getWrapUpDraftStorageKey(), serialized);
      this.lastWrapUpDraftSnapshot = serialized;
    } catch (error) {
      console.warn('[WrapUp] Failed to persist local wrap-up draft.', error);
    }
  }

  private async hydrateWrapUpDraftIfPresent() {
    if (!this.serviceOrderId) {
      return;
    }

    const storageKey = this.getWrapUpDraftStorageKey();
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed?.wrapUpForm && typeof parsed.wrapUpForm === 'object') {
        this.wrapUpForm = {
          ...this.wrapUpForm,
          ...parsed.wrapUpForm,
        };
      }

      this.lastWrapUpDraftSnapshot = JSON.stringify(this.buildWrapUpDraftData());
      console.log('[WrapUp] Hydrated local wrap-up draft from storage.', {
        storageKey,
        serviceOrderId: this.serviceOrderId,
      });
    } catch (error) {
      console.warn('[WrapUp] Failed to hydrate local wrap-up draft. Clearing corrupt draft.', error);
      localStorage.removeItem(storageKey);
      this.lastWrapUpDraftSnapshot = '';
    }
  }

  private clearWrapUpDraft() {
    if (!this.serviceOrderId) {
      return;
    }

    localStorage.removeItem(this.getWrapUpDraftStorageKey());
    this.lastWrapUpDraftSnapshot = '';
  }

  isAllTechnicianAssignmentsCompleted(): boolean {
    if (this.serviceOrderAssignments.length === 0) {
      return false;
    }
    return this.serviceOrderAssignments.every((assignment) => {
      const status = (assignment.assignmentStatus || '').toString().trim().toLowerCase();
      return status === 'completed';
    });
  }

  isWrapUpFormValid(): boolean {
    // Core required fields for the Lead Tech Wrap-Up submission gate.
    // Expand this checklist as business rules are defined.
    return (
      (this.wrapUpForm.leadTechnician || '').toString().trim().length > 0 &&
      (this.wrapUpForm.arrivalTime || '').toString().trim().length > 0 &&
      (this.wrapUpForm.completionTime || '').toString().trim().length > 0 &&
      this.wrapUpForm.prepWalkthroughDone &&
      this.wrapUpForm.serviceCheckComplete &&
      this.wrapUpForm.cleanupComplete &&
      this.wrapUpForm.allServicesCompleted &&
      this.wrapUpForm.customerApproved
    );
  }

  isSubmitWrapUpEnabled(): boolean {
    return this.isAllTechnicianAssignmentsCompleted() && this.isWrapUpFormValid();
  }

  async onSaveWrapUpDraft() {
    this.persistWrapUpDraftIfChanged();
    console.log('[WrapUp] Save Draft placeholder triggered.', {
      serviceOrderId: this.serviceOrderId,
    });
  }

  async onSubmitWrapUpServiceOrder() {
    if (!this.isSubmitWrapUpEnabled()) {
      console.warn('[WrapUp] Submit blocked: assignments or validation incomplete.', {
        serviceOrderId: this.serviceOrderId,
        allAssignmentsCompleted: this.isAllTechnicianAssignmentsCompleted(),
        wrapUpFormValid: this.isWrapUpFormValid(),
      });
      return;
    }

    console.log('[WrapUp] Submit Service Order placeholder triggered.', {
      serviceOrderId: this.serviceOrderId,
    });
  }

  cycleGroundInspectionItemState(item: { state: 0 | 1 | 2 }) {
    if (this.isHubInputLocked()) {
      return;
    }

    item.state = ((item.state + 1) % 3) as 0 | 1 | 2;
  }

  getGroundInspectionTileClass(item: { state: 0 | 1 | 2 }): string {
    if (item.state === 1) {
      return 'ground-inspection-tile ground-inspection-tile--pass';
    }

    if (item.state === 2) {
      return 'ground-inspection-tile ground-inspection-tile--fail';
    }

    return 'ground-inspection-tile ground-inspection-tile--idle';
  }

  onBootsNeededChange(isNeeded: boolean) {
    this.inspectionForm.bootsNeeded = !!isNeeded;
    if (this.inspectionForm.bootsNeeded) {
      this.persistInspectionDraftIfChanged();
      return;
    }

    this.inspectionForm.bootQty15 = '';
    this.inspectionForm.bootQty2 = '';
    this.inspectionForm.bootQty3 = '';
    this.persistInspectionDraftIfChanged();
  }

  onVentsNeededChange(isNeeded: boolean) {
    this.inspectionForm.ventsNeeded = !!isNeeded;
    if (this.inspectionForm.ventsNeeded) {
      this.persistInspectionDraftIfChanged();
      return;
    }

    this.inspectionForm.af50VentQty = '';
    this.inspectionForm.bf4VentQty = '';
    this.inspectionForm.bf6VentQty = '';
    this.persistInspectionDraftIfChanged();
  }

  onQuantityFieldChanged(
    field: 'bootQty15' | 'bootQty2' | 'bootQty3' | 'af50VentQty' | 'bf4VentQty' | 'bf6VentQty',
    value: any
  ) {
    this.inspectionForm[field] = (value ?? '').toString();
    this.persistInspectionDraftIfChanged();
  }

  private flushInspectionInputStateBeforeCamera() {
    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement && typeof activeElement.blur === 'function') {
      activeElement.blur();
    }

    this.inspectionForm.bootQty15 = (this.inspectionForm.bootQty15 ?? '').toString();
    this.inspectionForm.bootQty2 = (this.inspectionForm.bootQty2 ?? '').toString();
    this.inspectionForm.bootQty3 = (this.inspectionForm.bootQty3 ?? '').toString();
    this.inspectionForm.af50VentQty = (this.inspectionForm.af50VentQty ?? '').toString();
    this.inspectionForm.bf4VentQty = (this.inspectionForm.bf4VentQty ?? '').toString();
    this.inspectionForm.bf6VentQty = (this.inspectionForm.bf6VentQty ?? '').toString();

    this.persistInspectionDraftIfChanged();
  }

  // --- Roof data helpers ---

  getRelatedLocationId(): string {
    const fid7 = (this.job?.['7']?.value || '').toString().trim();
    const fid6 = (this.job?.['6']?.value || '').toString().trim();
    const fid90 = (this.job?.['90']?.value || '').toString().trim();

    // Prefer relational IDs first; FID 90 is usually a display address.
    const candidate = fid7 || fid6 || fid90;
    return candidate;
  }

  async loadRoofs() {
    const locationId = this.getRelatedLocationId();
    if (!locationId) {
      console.warn('[InspectionHub][Roofs] Missing related location id on job record.', {
        activeJobId: this.activeJobId,
        jobRecordId: (this.job?.['3']?.value || '').toString(),
        fid7: (this.job?.['7']?.value || '').toString(),
        fid6: (this.job?.['6']?.value || '').toString(),
        fid90: (this.job?.['90']?.value || '').toString(),
      });
      return;
    }

    console.log('[InspectionHub][Roofs] Loading roofs for location.', {
      activeJobId: this.activeJobId,
      jobRecordId: (this.job?.['3']?.value || '').toString(),
      locationId,
      fid7: (this.job?.['7']?.value || '').toString(),
      fid6: (this.job?.['6']?.value || '').toString(),
      fid90: (this.job?.['90']?.value || '').toString(),
    });

    const selectedRoofRecordId = (this.selectedRoofObj?.['3']?.value || '').toString();
    this.roofsLoading = true;
    this.roofs = await this.authService.getRoofsByLocation(locationId);

    console.log('[InspectionHub][Roofs] Roof query completed.', {
      locationId,
      returnedCount: Array.isArray(this.roofs) ? this.roofs.length : 0,
      firstRoof: Array.isArray(this.roofs) && this.roofs.length > 0 ? this.roofs[0] : null,
    });

    if (this.roofs.length > 0) {
      const reselection = this.roofs.find(
        (roof) => (roof?.['3']?.value || '').toString() === selectedRoofRecordId
      );
      this.selectedRoofObj = reselection || this.roofs[0];
    } else {
      this.selectedRoofObj = null;
    }
    this.roofsLoading = false;
  }

  selectRoof(roof: any) {
    this.selectedRoofObj = roof;
  }

  isSelectedRoof(roof: any): boolean {
    return (
      this.selectedRoofObj?.['3']?.value !== undefined &&
      this.selectedRoofObj?.['3']?.value === roof?.['3']?.value
    );
  }

  getRoofName(roof: any): string {
    return (roof?.['60']?.value || 'Unnamed').toString();
  }

  getRoofMaterial(roof: any): string {
    return (roof?.['69']?.value || '—').toString();
  }

  getRoofPitch(roof: any): string {
    return (roof?.['63']?.value || '—').toString();
  }

  getRoofSquareFootage(roof: any): string {
    const rawValue = (roof?.['61']?.value ?? '').toString().trim();
    return rawValue ? `${rawValue} sq ft` : '—';
  }

  getRoofType(roof: any): string {
    return (roof?.['67']?.value || '—').toString();
  }

  getRoofBrand(roof: any): string {
    return (roof?.['71']?.value || '—').toString();
  }

  getRoofColor(roof: any): string {
    return (roof?.['65']?.value || '—').toString();
  }

  getRoofStatus(roof: any): string {
    return (roof?.['59']?.value || '—').toString();
  }

  openEditRoof(roof: any, event: Event) {
    event.stopPropagation();
    if (this.isHubInputLocked()) {
      return;
    }
    this.editingRoof = roof;
    this.editForm = {
      material: (roof?.['69']?.value || '').toString(),
      pitch: (roof?.['63']?.value || '').toString(),
      roofType: (roof?.['67']?.value || '').toString(),
      brand: (roof?.['71']?.value || '').toString(),
      color: (roof?.['65']?.value || '').toString(),
      sqft: (roof?.['61']?.value || '').toString(),
    };
  }

  closeEditModal() {
    this.editingRoof = null;
  }

  async saveEditRoof() {
    if (!this.editingRoof) {
      return;
    }

    const selectedRoof = this.editingRoof;
    const targetRoofId = selectedRoof?.['3']?.value; // The true Roof Record ID (e.g. 7)

    if (!Number.isFinite(Number(targetRoofId))) {
      console.warn('Roof edit blocked: invalid roof record id.', {
        targetRoofId,
        selectedRoof,
      });
      return;
    }

    const updatePayload = {
      roofId: Number(targetRoofId),
      fields: {
        '61': Number(this.editForm.sqft) || selectedRoof?.['61']?.value,
        '63': this.editForm.pitch || selectedRoof?.['63']?.value,
        '65': this.editForm.color || selectedRoof?.['65']?.value,
        '67': this.editForm.roofType || selectedRoof?.['67']?.value,
        '69': this.editForm.material || selectedRoof?.['69']?.value,
        '71': this.editForm.brand || selectedRoof?.['71']?.value
      }
    };

    console.log('--- OUTBOUND ROOF DATA MUTATION HANDSHAKE ---', updatePayload);
    console.log('--- OUTBOUND ROOF UPDATE EXECUTION TRIGGER ---', {
      roofId: updatePayload.roofId,
      awaitingNetworkMutation: true,
    });

    const response = await firstValueFrom(this.authService.updateRoof(updatePayload));
    if (!response?.success) {
      return;
    }

    this.closeEditModal();
    await this.loadRoofs();
  }

  openAddRoof() {
    if (this.isHubInputLocked()) {
      return;
    }
    this.addForm = {
      label: '',
      material: '',
      pitch: '',
      roofType: '',
      brand: '',
      color: '',
      sqft: ''
    };
    this.showAddModal = true;
  }

  closeAddModal() {
    this.showAddModal = false;
  }

  async saveAddRoof() {
    const locationId = this.getRelatedLocationId();
    const didSave = await this.authService.saveRoof(locationId, this.addForm);
    if (!didSave) {
      return;
    }

    this.closeAddModal();
    await this.loadRoofs();
  }

  async beginSectionPhotoCapture(sectionKey: InspectionPhotoSectionKey, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();

    this.flushInspectionInputStateBeforeCamera();

    if (this.isHubInputLocked() || this.isCapturingPhoto) {
      return;
    }

    await this.capturePhotoForSection(sectionKey);
  }

  private async capturePhotoForSection(sectionKey: InspectionPhotoSectionKey) {
    try {
      this.isCapturingPhoto = true;
      const photo = await Camera.getPhoto({
        quality: 85,
        width: 1920,
        height: 1920,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
      });

      if (!photo?.dataUrl) {
        return;
      }

      const optimizedDataUrl = await this.optimizePhotoDataUrl(photo.dataUrl);
      const photoBlob = await this.dataUrlToBlob(optimizedDataUrl);
      this.pendingPhotoPreview = {
        sectionKey,
        taskId: null,
        taskSlot: null,
        dataUrl: optimizedDataUrl,
        blob: photoBlob,
        notes: '',
      };
      this.isPhotoPreviewOpen = true;
    } catch (error: any) {
      const message = (error?.message || '').toString().toLowerCase();
      if (message.includes('cancel')) {
        return;
      }

      console.warn('[InspectionPhotos] Camera capture failed:', error);
    } finally {
      this.isCapturingPhoto = false;
    }
  }

  private async dataUrlToBlob(dataUrl: string): Promise<Blob> {
    const response = await fetch(dataUrl);
    return response.blob();
  }

  private async optimizePhotoDataUrl(dataUrl: string): Promise<string> {
    const value = (dataUrl || '').toString();
    if (!value.startsWith('data:image/')) {
      return value;
    }

    try {
      const image = await this.loadImageFromDataUrl(value);
      const sourceWidth = image.naturalWidth || image.width || 0;
      const sourceHeight = image.naturalHeight || image.height || 0;
      if (!sourceWidth || !sourceHeight) {
        return value;
      }

      const maxDimension = 1920;
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const context = canvas.getContext('2d');
      if (!context) {
        return value;
      }

      context.drawImage(image, 0, 0, targetWidth, targetHeight);
      const outputDataUrl = canvas.toDataURL('image/jpeg', 0.78);
      return outputDataUrl || value;
    } catch {
      return value;
    }
  }

  private loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = (error) => reject(error);
      image.src = dataUrl;
    });
  }

  closePhotoPreview() {
    this.isPhotoPreviewOpen = false;
    this.pendingPhotoPreview = null;
  }

  async retakePendingPhoto() {
    const { sectionKey, taskId, taskSlot } = this.pendingPhotoPreview || {};
    this.closePhotoPreview();

    if (taskId && taskSlot) {
      await this.beginTaskPhotoCapture(taskId, taskSlot);
      return;
    }

    if (!sectionKey) {
      return;
    }

    await this.beginSectionPhotoCapture(sectionKey);
  }

  async acceptPendingPhoto() {
    console.log('[DIAG] acceptPendingPhoto() entry — pendingPhotoPreview:', this.pendingPhotoPreview);
    if (!this.pendingPhotoPreview) {
      console.log('[DIAG] acceptPendingPhoto() — early return: pendingPhotoPreview is null');
      return;
    }

    const { sectionKey, taskId, taskSlot, dataUrl, blob, notes } = this.pendingPhotoPreview;
    console.log('[DIAG] acceptPendingPhoto() — destructured:', { sectionKey, taskId, taskSlot, blobSize: (blob as any)?.size, notesLen: notes?.length });

    console.log('[DIAG] acceptPendingPhoto() — before task branch check: taskId=', taskId, 'taskSlot=', taskSlot);
    if (taskId && taskSlot) {
      console.log('[DIAG] acceptPendingPhoto() — ENTERED task branch');
      console.log('[DIAG] serviceOrderId:', this.serviceOrderId);
      console.log('[DIAG] blob constructor:', blob?.constructor?.name, 'size:', (blob as any)?.size);
      const slotKey = `${taskSlot}-${taskId}`;
      if (!this.taskPhotoState[slotKey]) {
        this.taskPhotoState[slotKey] = [];
      }
      const nextIndex = this.taskPhotoState[slotKey].length + 1;
      const fileName = `task-${taskSlot}-${taskId}_pic_${nextIndex}.jpg`;
      const capturedAt = Date.now();
      const trimmedNotes = (notes || '').trim();
      this.taskPhotoState[slotKey].push({
        fileName,
        dataUrl,
        blob,
        notes: trimmedNotes,
        capturedAt,
      });
      this.closePhotoPreview();
      console.log('[DIAG] acceptPendingPhoto() — immediately before uploadTaskPhoto()', { serviceOrderId: this.serviceOrderId, taskId, taskSlot, fileName, blobSize: (blob as any)?.size });
      this.collaborationService.uploadTaskPhoto(
        this.serviceOrderId, taskId, taskSlot, fileName, blob
      ).then(storageUrl => {
        console.log('[DIAG] acceptPendingPhoto() — immediately after uploadTaskPhoto() returned. storageUrl:', storageUrl);
        const entry = this.taskPhotoState[slotKey]?.find(p => p.fileName === fileName);
        if (entry) {
          entry.dataUrl = storageUrl;
        }
        console.log('[DIAG] acceptPendingPhoto() — immediately before addTaskPhoto()');
        return this.collaborationService.addTaskPhoto(
          this.serviceOrderId, taskId, taskSlot,
          { fileName, notes: trimmedNotes, capturedAt, storageUrl }
        );
      }).then(() => {
        console.log('[DIAG] acceptPendingPhoto() — immediately after addTaskPhoto() returned. Firestore updated.');
      }).catch(err => {
        console.warn('[DIAG] acceptPendingPhoto() — CATCH in upload/Firestore chain:', err);
      });
      return;
    }

    // Inspection photo path — unchanged
    if (!sectionKey) {
      return;
    }
    const nextFileIndex = this.inspectionPhotoState[sectionKey].length + 1;
    const fileName = `${sectionKey}_pic_${nextFileIndex}.jpg`;

    this.inspectionPhotoState[sectionKey].push({
      fileName,
      dataUrl,
      blob,
      notes: (notes || '').trim(),
      capturedAt: Date.now(),
    });

    void this.persistInspectionPhotosToIndexedDbIfChanged();

    this.closePhotoPreview();
  }

  getInspectionSectionFileNames(sectionKey: InspectionPhotoSectionKey): string[] {
    return this.inspectionPhotoState[sectionKey].map((photo) => photo.fileName);
  }

  getBootVentPhotoFileNames(): string[] {
    return [
      ...this.getInspectionSectionFileNames('boot'),
      ...this.getInspectionSectionFileNames('vents'),
    ];
  }

  async onCompleteInspection() {
    if (this.isHubInputLocked() || this.isCompletingInspection) {
      return;
    }

    this.isCompletingInspection = true;
    try {
      await this.loadingService.withLoading(
        'Completing Inspection...',
        async () => {
          const payload = this.buildInspectionSubmissionPayload();
          console.log(
            'DEBUG INSPECTION SUBMISSION PAYLOAD\n' +
              JSON.stringify(payload, null, 2)
          );

          const didSubmit = await this.authService.submitInspectionData(payload);
          if (!didSubmit) {
            console.error('[InspectionHub] Inspection data submission failed.');
            return;
          }

          const workflowLog = this.buildInspectionWorkflowLogPayload();
          const didAdvanceStatus = await this.authService.updateServiceOrderStatus(
            this.activeJobId,
            'Inspected',
            workflowLog
          );
          if (!didAdvanceStatus) {
            console.error('[InspectionHub] Inspection status advancement to Inspected failed.');
            return;
          }

          this.persistInspectionCache(payload);
          await this.clearInspectionDraft();

          this.goBack();
        }
      );
    } finally {
      this.isCompletingInspection = false;
    }
  }

  private persistInspectionDraftIfChanged() {
    if (!this.isInspection() || !this.serviceOrderId) {
      return;
    }

    try {
      const currentData = this.buildInspectionDraftData();
      const serialized = JSON.stringify(currentData);
      if (!serialized || serialized === this.lastDraftSnapshot) {
        return;
      }

      localStorage.setItem(this.getInspectionDraftStorageKey(), serialized);
      this.lastDraftSnapshot = serialized;
      void this.persistInspectionPhotosToIndexedDbIfChanged();
    } catch (error) {
      console.warn('[InspectionHub] Failed to persist local inspection draft.', error);
    }
  }

  private async hydrateInspectionDraftIfPresent() {
    if (!this.serviceOrderId) {
      return;
    }

    const storageKey = this.getInspectionDraftStorageKey();
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed?.inspectionForm && typeof parsed.inspectionForm === 'object') {
        this.inspectionForm = {
          ...this.inspectionForm,
          ...parsed.inspectionForm,
        };
      }

      if (Array.isArray(parsed?.groundInspectionItems)) {
        this.groundInspectionItems = this.groundInspectionItems.map((item) => {
          const saved = parsed.groundInspectionItems.find((row: any) => Number(row?.id) === item.id);
          if (!saved) {
            return item;
          }

          const nextState = Number(saved.state);
          return {
            ...item,
            state: nextState === 1 || nextState === 2 ? nextState : 0,
          } as { id: number; name: string; state: 0 | 1 | 2 };
        });
      }

      const persistedPhotoState = await this.readInspectionPhotosFromIndexedDb(this.serviceOrderId);
      const photoStateSource =
        persistedPhotoState && typeof persistedPhotoState === 'object'
          ? persistedPhotoState
          : parsed?.inspectionPhotoState && typeof parsed.inspectionPhotoState === 'object'
            ? parsed.inspectionPhotoState
            : null;

      if (photoStateSource && typeof photoStateSource === 'object') {
        const nextPhotoState: Record<InspectionPhotoSectionKey, InspectionPhotoAttachment[]> = {
          penetrations: [],
          fieldCondition: [],
          ridgeCondition: [],
          flashing: [],
          boot: [],
          vents: [],
          ground: [],
        };

        const sectionKeys = Object.keys(nextPhotoState) as InspectionPhotoSectionKey[];
        for (const sectionKey of sectionKeys) {
          const rows = Array.isArray(photoStateSource?.[sectionKey])
            ? photoStateSource[sectionKey]
            : [];

          nextPhotoState[sectionKey] = rows
            .filter((row: any) => typeof row?.dataUrl === 'string' && row.dataUrl.length > 0)
            .map((row: any, index: number) => {
              const fileName = (row?.fileName || `${sectionKey}_pic_${index + 1}.jpg`).toString();
              const dataUrl = row.dataUrl.toString();
              return {
                fileName,
                dataUrl,
                blob: this.dataUrlToBlobSync(dataUrl),
                notes: (row?.notes || '').toString(),
                capturedAt: Number.isFinite(Number(row?.capturedAt)) ? Number(row.capturedAt) : Date.now(),
              };
            });
        }

        this.inspectionPhotoState = nextPhotoState;
      }

      this.lastDraftSnapshot = JSON.stringify(this.buildInspectionDraftData());
      this.lastPhotoDraftSnapshot = JSON.stringify(this.buildSerializedInspectionPhotoState());
      console.log('[InspectionHub] Hydrated local inspection draft from storage.', {
        storageKey,
        serviceOrderId: this.serviceOrderId,
      });
    } catch (error) {
      console.warn('[InspectionHub] Failed to hydrate local inspection draft. Clearing corrupt draft.', error);
      localStorage.removeItem(storageKey);
      this.lastDraftSnapshot = '';
      this.lastPhotoDraftSnapshot = '';
    }
  }

  private async clearInspectionDraft() {
    if (!this.serviceOrderId) {
      return;
    }

    localStorage.removeItem(this.getInspectionDraftStorageKey());
    await this.deleteInspectionPhotoDraftFromIndexedDb(this.serviceOrderId);
    this.lastDraftSnapshot = '';
    this.lastPhotoDraftSnapshot = '';
  }

  private getInspectionCacheStorageKey(serviceOrderId: string): string {
    return `${JobDetailPage.INSPECTION_CACHE_PREFIX}${(serviceOrderId || '').trim()}`;
  }

  private persistInspectionCache(payload: InspectionSubmissionPayload) {
    const serviceOrderId = (payload?.serviceOrderId || this.serviceOrderId || '').toString().trim();
    if (!serviceOrderId) {
      return;
    }

    const cacheData = {
      serviceOrderId,
      masterJobRecordValues: payload?.masterJobRecordValues || {},
      photoBatchData: payload?.photoBatchData || { tableId: 'bv3mp7tra', rows: [] },
      photoCount: Array.isArray(payload?.photoBatchData?.rows) ? payload.photoBatchData.rows.length : 0,
      cachedAt: new Date().toISOString(),
    };

    const compactCacheData = {
      serviceOrderId,
      masterJobRecordValues: payload?.masterJobRecordValues || {},
      photoBatchData: { tableId: 'bv3mp7tra', rows: [] },
      photoCount: cacheData.photoCount,
      cachedAt: cacheData.cachedAt,
    };

    const storageKey = this.getInspectionCacheStorageKey(serviceOrderId);

    try {
      localStorage.setItem(storageKey, JSON.stringify(cacheData));
      return;
    } catch (error) {
      if (!this.isStorageQuotaExceededError(error)) {
        console.warn('[InspectionHub] Failed to persist inspection cache.', error);
        return;
      }

      console.warn('[InspectionHub] Inspection cache exceeded localStorage quota. Retrying with compact payload.', {
        serviceOrderId,
        photoCount: cacheData.photoCount,
      });
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify(compactCacheData));
      return;
    } catch (error) {
      if (!this.isStorageQuotaExceededError(error)) {
        console.warn('[InspectionHub] Failed to persist compact inspection cache.', error);
        return;
      }

      this.evictOldInspectionCaches(serviceOrderId);
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify(compactCacheData));
    } catch (error) {
      console.warn('[InspectionHub] Failed to persist compact inspection cache after cleanup. Continuing without cache persistence.', error);
    }
  }

  private evictOldInspectionCaches(retainServiceOrderId: string) {
    const retainKey = this.getInspectionCacheStorageKey(retainServiceOrderId);
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(JobDetailPage.INSPECTION_CACHE_PREFIX) || key === retainKey) {
        continue;
      }

      localStorage.removeItem(key);
    }
  }

  private isStorageQuotaExceededError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const storageError = error as { name?: string; code?: number; message?: string };
    const message = String(storageError.message || '').toLowerCase();
    return (
      storageError.name === 'QuotaExceededError' ||
      storageError.code === 22 ||
      storageError.code === 1014 ||
      message.includes('quota')
    );
  }

  private buildInspectionDraftData() {
    const serializedPhotoState = this.isIndexedDbAvailable()
      ? undefined
      : this.buildSerializedInspectionPhotoState();

    return {
      serviceOrderId: this.serviceOrderId,
      inspectionForm: { ...this.inspectionForm },
      groundInspectionItems: this.groundInspectionItems.map((item) => ({
        id: item.id,
        state: item.state,
      })),
      inspectionPhotoState: serializedPhotoState,
    };
  }

  private buildSerializedInspectionPhotoState(): Record<InspectionPhotoSectionKey, Array<{
    fileName: string;
    dataUrl: string;
    notes: string;
    capturedAt: number;
  }>> {
    const serializedPhotoState: Record<InspectionPhotoSectionKey, Array<{
      fileName: string;
      dataUrl: string;
      notes: string;
      capturedAt: number;
    }>> = {
      penetrations: [],
      fieldCondition: [],
      ridgeCondition: [],
      flashing: [],
      boot: [],
      vents: [],
      ground: [],
    };

    const sectionKeys = Object.keys(serializedPhotoState) as InspectionPhotoSectionKey[];
    for (const sectionKey of sectionKeys) {
      const sectionPhotos = this.inspectionPhotoState[sectionKey] || [];
      serializedPhotoState[sectionKey] = sectionPhotos.map((photo) => ({
        fileName: (photo.fileName || '').toString(),
        dataUrl: (photo.dataUrl || '').toString(),
        notes: (photo.notes || '').toString(),
        capturedAt: Number(photo.capturedAt) || Date.now(),
      }));
    }

    return serializedPhotoState;
  }

  private async persistInspectionPhotosToIndexedDbIfChanged() {
    if (!this.serviceOrderId || !this.isIndexedDbAvailable()) {
      return;
    }

    const serializedPhotoState = this.buildSerializedInspectionPhotoState();
    const snapshot = JSON.stringify(serializedPhotoState);
    if (!snapshot || snapshot === this.lastPhotoDraftSnapshot) {
      return;
    }

    try {
      await this.writeInspectionPhotoDraftToIndexedDb(this.serviceOrderId, serializedPhotoState);
      this.lastPhotoDraftSnapshot = snapshot;
    } catch (error) {
      console.warn('[InspectionHub] Failed to persist inspection photos in IndexedDB.', error);
    }
  }

  private isIndexedDbAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private openInspectionDraftDb(): Promise<IDBDatabase | null> {
    if (!this.isIndexedDbAvailable()) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const request = indexedDB.open(
        JobDetailPage.INSPECTION_DRAFT_DB_NAME,
        JobDetailPage.INSPECTION_DRAFT_DB_VERSION
      );

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(JobDetailPage.INSPECTION_PHOTO_STORE_NAME)) {
          db.createObjectStore(JobDetailPage.INSPECTION_PHOTO_STORE_NAME, {
            keyPath: 'serviceOrderId',
          });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('[InspectionHub] Unable to open IndexedDB for inspection draft photos.', request.error);
        resolve(null);
      };
    });
  }

  private async writeInspectionPhotoDraftToIndexedDb(
    serviceOrderId: string,
    inspectionPhotoState: Record<InspectionPhotoSectionKey, Array<{
      fileName: string;
      dataUrl: string;
      notes: string;
      capturedAt: number;
    }>>
  ): Promise<void> {
    const db = await this.openInspectionDraftDb();
    if (!db) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(JobDetailPage.INSPECTION_PHOTO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(JobDetailPage.INSPECTION_PHOTO_STORE_NAME);
      store.put({
        serviceOrderId,
        inspectionPhotoState,
        updatedAt: Date.now(),
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB photo draft write failed.'));
    });

    db.close();
  }

  private async readInspectionPhotosFromIndexedDb(
    serviceOrderId: string
  ): Promise<Record<InspectionPhotoSectionKey, Array<{
    fileName: string;
    dataUrl: string;
    notes: string;
    capturedAt: number;
  }>> | null> {
    const db = await this.openInspectionDraftDb();
    if (!db) {
      return null;
    }

    try {
      const row = await new Promise<any>((resolve, reject) => {
        const tx = db.transaction(JobDetailPage.INSPECTION_PHOTO_STORE_NAME, 'readonly');
        const store = tx.objectStore(JobDetailPage.INSPECTION_PHOTO_STORE_NAME);
        const request = store.get(serviceOrderId);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('IndexedDB photo draft read failed.'));
      });

      return row?.inspectionPhotoState || null;
    } catch (error) {
      console.warn('[InspectionHub] Failed reading inspection photos from IndexedDB.', error);
      return null;
    } finally {
      db.close();
    }
  }

  private async deleteInspectionPhotoDraftFromIndexedDb(serviceOrderId: string): Promise<void> {
    const db = await this.openInspectionDraftDb();
    if (!db) {
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(JobDetailPage.INSPECTION_PHOTO_STORE_NAME, 'readwrite');
        const store = tx.objectStore(JobDetailPage.INSPECTION_PHOTO_STORE_NAME);
        store.delete(serviceOrderId);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB photo draft delete failed.'));
      });
    } catch (error) {
      console.warn('[InspectionHub] Failed clearing IndexedDB photo draft.', error);
    } finally {
      db.close();
    }
  }

  private dataUrlToBlobSync(dataUrl: string): Blob {
    try {
      const value = (dataUrl || '').toString();
      const commaIndex = value.indexOf(',');
      if (commaIndex === -1) {
        return new Blob([]);
      }

      const header = value.slice(0, commaIndex);
      const base64 = value.slice(commaIndex + 1);
      const mimeMatch = /data:(.*?);base64/.exec(header);
      const mimeType = mimeMatch?.[1] || 'application/octet-stream';
      const binary = atob(base64);
      const length = binary.length;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      return new Blob([bytes], { type: mimeType });
    } catch {
      return new Blob([]);
    }
  }

  private buildInspectionWorkflowLogPayload(): WorkflowLogPayload | undefined {
    const rawEmployeeId = Number.parseInt(
      String(this.authService.getUser()?.id || this.authService.getUser()?.employeeId || ''),
      10
    );

    if (!Number.isFinite(rawEmployeeId)) {
      return undefined;
    }

    return {
      eventType: 'Complete',
      eventTimestamp: new Date().toISOString(),
      gpsCoordinates: 'Unavailable',
      notes: 'Status set to Inspected after submit-inspection-data success.',
      relatedEmployeeId: rawEmployeeId,
    };
  }

  private buildInspectionSubmissionPayload(): InspectionSubmissionPayload {
    const serviceOrderId = (this.activeJobId || '').toString();

    const groundFieldMap: Record<number, string> = {
      1: '118',
      2: '120',
      3: '121',
      4: '122',
      5: '123',
      6: '124',
      7: '125',
      8: '126',
    };

    const masterJobRecordValues: Record<string, string | number | boolean | null> = {
      '48': this.inspectionForm.penetrationsLeaks || '',
      '49': this.inspectionForm.fieldCondition || '',
      '50': this.inspectionForm.ridgeCondition || '',
      '153': Array.isArray(this.inspectionForm.flashingsNeedingService) ? this.inspectionForm.flashingsNeedingService.join(';') : this.inspectionForm.flashingsNeedingService || '',
      '51': !!this.inspectionForm.bootsNeeded,
      '52': this.toOptionalNumber(this.inspectionForm.bootQty15),
      '56': this.toOptionalNumber(this.inspectionForm.bootQty2),
      '57': this.toOptionalNumber(this.inspectionForm.bootQty3),
      '55': !!this.inspectionForm.ventsNeeded,
      '53': this.toOptionalNumber(this.inspectionForm.af50VentQty),
      '59': this.toOptionalNumber(this.inspectionForm.bf4VentQty),
      '58': this.toOptionalNumber(this.inspectionForm.bf6VentQty),
      '10': this.inspectionForm.inspectionNotes || '',
    };

    for (const item of this.groundInspectionItems) {
      const targetFid = groundFieldMap[item.id];
      if (!targetFid) {
        continue;
      }

      masterJobRecordValues[targetFid] = this.toGroundChoiceValue(item.state);
    }

    const photoRows: InspectionPhotoBatchRow[] = [];
    const sectionKeys = Object.keys(this.inspectionPhotoState) as InspectionPhotoSectionKey[];

    for (const sectionKey of sectionKeys) {
      const sectionPhotos = this.inspectionPhotoState[sectionKey] || [];
      for (const photo of sectionPhotos) {
        photoRows.push({
          fid_6: sectionKey,
          fid_7: (photo.notes || '').trim(),
          fid_8: this.extractBase64Data(photo.dataUrl),
          fid_9: serviceOrderId,
        });
      }
    }

    return {
      serviceOrderId,
      masterJobRecordValues,
      photoBatchData: {
        tableId: 'bv3mp7tra',
        rows: photoRows,
      },
    };
  }

  private toOptionalNumber(value: string): number | null {
    const normalized = (value || '').toString().trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toGroundChoiceValue(state: 0 | 1 | 2): string {
    if (state === 1) {
      return 'Pass';
    }

    if (state === 2) {
      return 'Fail';
    }

    return '';
  }

  private extractBase64Data(dataUrl: string): string {
    const value = (dataUrl || '').toString();
    const commaIndex = value.indexOf(',');
    if (commaIndex === -1) {
      return value;
    }

    return value.slice(commaIndex + 1);
  }
}
