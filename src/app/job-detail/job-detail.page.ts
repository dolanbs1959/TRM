import { Component, DoCheck, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { firstValueFrom } from 'rxjs';
import { AuthService, RoofOptionCacheData, WorkflowLogPayload } from '../services/auth.service';
import { LoadingService } from '../services/loading.service';

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
}

interface PendingInspectionPhoto {
  sectionKey: InspectionPhotoSectionKey;
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
  private static readonly ACTIVE_JOB_PAUSED_STORAGE_KEY = 'trm.activeJobPaused';
  private static readonly INSPECTION_CACHE_PREFIX = 'trm.inspectionCache.';
  private static readonly INSPECTION_DRAFT_DB_NAME = 'trmInspectionDraftDb';
  private static readonly INSPECTION_DRAFT_DB_VERSION = 1;
  private static readonly INSPECTION_PHOTO_STORE_NAME = 'inspectionPhotoDrafts';

  isLoading = true;
  job: any = null;
  activeJobId = '';
  pageMode: 'view' | 'work' = 'view';
  isPausedWorkflow = false;
  inspectionHubSegment: 'checklist' | 'notes' = 'checklist';

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

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService,
    private loadingService: LoadingService
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
      JobDetailPage.ACTIVE_JOB_PAUSED_STORAGE_KEY,
      this.isPausedWorkflow ? '1' : '0'
    );
    await this.loadJobDetail();
  }

  ngDoCheck() {
    this.persistInspectionDraftIfChanged();
  }

  private normalizeMode(value: string): 'view' | 'work' | null {
    const mode = (value || '').toString().trim().toLowerCase();
    if (mode === 'view' || mode === 'work') {
      return mode;
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

  isWorkOrder() {
    const stage = this.getStage();
    return stage === 'service order' || stage === 'work order';
  }

  isReadOnlyMode() {
    return this.pageMode === 'view';
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
    const sectionKey = this.pendingPhotoPreview?.sectionKey;
    this.closePhotoPreview();

    if (!sectionKey) {
      return;
    }

    await this.beginSectionPhotoCapture(sectionKey);
  }

  acceptPendingPhoto() {
    if (!this.pendingPhotoPreview) {
      return;
    }

    const { sectionKey, dataUrl, blob, notes } = this.pendingPhotoPreview;
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
