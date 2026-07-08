import { AfterViewInit, Component, DoCheck, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { trash } from 'ionicons/icons';
import { AuthService, OfferedServiceItem } from '../services/auth.service';
import { LoadingService } from '../services/loading.service';
import { EstimateWorkflow } from '../home/home.page';
import { calculateTax, getTaxRate } from '../services/tax-utility.service';

interface EstimateFieldDefinition {
  label: string;
  fid: number;
  boolean?: boolean;
}

interface EstimateFieldRow {
  label: string;
  value: string;
}

interface CachedInspectionPhoto {
  id: string;
  src: string;
  section: string;
  notes: string;
}

interface InspectionRoofTile {
  id: string;
  name: string;
  material: string;
  pitch: string;
  squareFootage: number;
  squareFootageLabel: string;
  type: string;
  status: string;
  isAdded: boolean;
}

interface EstimateCatalogItem {
  id: number;
  name: string;
  description: string;
  category: string;
  serviceType: string;
  unit: string;
  price: number;
  isPackage: boolean;
  packageTier: string;
  sortOrder: number;
}

interface ActiveEstimateItem extends Omit<EstimateCatalogItem, 'price'> {
  qtyNeeded: number | null;
  price: number | null;
  lineSubtotal: number;
  sqFootage: number | null;
  specialInstructions?: string;
}

interface EstimateSubmissionPayloadItem {
  id: number;
  description: string;
  unit?: string;
  qtyNeeded: number;
  sqFootage: number;
  price: number;
  lineSubtotal: number;
  amount?: number;
  uom?: string;
  specialInstructions?: string;
}

interface EstimateCategoryGroup {
  label: string;
  items: EstimateCatalogItem[];
}

interface EstimatePackageSection {
  label: string;
  items: EstimateCatalogItem[];
}

@Component({
  selector: 'app-estimate',
  templateUrl: './estimate.page.html',
  styleUrls: ['./estimate.page.scss'],
  standalone: false,
})
export class EstimatePage implements OnInit, AfterViewInit, DoCheck, OnDestroy {
  @ViewChild('signatureCanvas') signatureCanvasRef?: ElementRef<HTMLCanvasElement>;

  job: any = null;
  jobId = '';
  inspectionCache: any = null;
  isPhotoViewerOpen = false;
  selectedPhoto: CachedInspectionPhoto | null = null;
  selectedPhotoIndex = -1;
  catalogItems: EstimateCatalogItem[] = [];
  activeEstimateItems: ActiveEstimateItem[] = [];
  serviceSearchTerm = '';
  isCatalogLoading = false;
  summaryFields: EstimateFieldRow[] = [];
  inspectionFields: EstimateFieldRow[] = [];
  groundInspectionFields: EstimateFieldRow[] = [];
  packageSections: EstimatePackageSection[] = [];
  tipTopRoofCareClubItems: EstimateCatalogItem[] = [];
  categorizedRepairGroups: EstimateCategoryGroup[] = [];
  filteredCatalogItems: EstimateCatalogItem[] = [];
  inspectionHubRoofTiles: InspectionRoofTile[] = [];
  selectedRoofSquareFootage = 0;
  roofsLoading = false;
  workOrderedBy = '';
  serviceNotes = '';
  locationEmail = '';
  customerRecordId = '';
  locationRecordId = '';
  customerReadyToBegin = false;
  discountsAvailable = false;
  discountControlValue = '';
  secondaryDiscountAmount: number | null = 0;
  secondaryDiscountPercentage: number | null = 0;
  isSubmittingEstimate = false;
  cleanMaintenanceScheduledFor = this.getTodayDateInputValue();
  repairServicesScheduledFor = this.getTodayDateInputValue();
  signatureDate = this.getTodayDateInputValue();
  discountMS = false;
  discountOther = false;
  msDiscountAmount: number | null = 0;
  otherDiscountAmount: number | null = 0;
  private signatureStrokeActive = false;
  private signatureHasInk = false;
  private viewerTouchStartX: number | null = null;
  private indexedDbInspectionPhotos: CachedInspectionPhoto[] = [];
  cachedInspectionPhotos: CachedInspectionPhoto[] = [];
  selectedPhotoIds: Set<string> = new Set<string>();
  selectAllPhotos = false;
  private msDiscountManuallyEdited = false;
  private lastDraftSnapshot = '';
  private lastPhotoDraftSnapshot = '';
  private lastEstimatePhotoSnapshot = '';
  private skipDraftPersistence = false;
  private unsignedEstimateSubmitted = false;
  isEstimateRevision = false;
  private static readonly INSPECTION_CACHE_PREFIX = 'trm.inspectionCache.';
  private static readonly INSPECTION_DRAFT_DB_NAME = 'trmInspectionDraftDb';
  private static readonly INSPECTION_DRAFT_DB_VERSION = 1;
  private static readonly INSPECTION_PHOTO_STORE_NAME = 'inspectionPhotoDrafts';
  private static readonly ESTIMATE_DRAFT_STORAGE_KEY_PREFIX = 'trm_estimate_draft_';
  private static readonly PACKAGE_SECTION_ORDER = ['Budget', 'Value', 'Basic Maintenance'];
  private readonly sectionNavIds = [
    'estimate-packages-section',
    'estimate-tiptop-section',
    'estimate-repairs-section',
    'estimate-active-section',
  ];
  private readonly activeSectionNavIndex = this.sectionNavIds.length - 1;
  private sectionNavObserver: IntersectionObserver | null = null;
  private sectionNavMutationObserver: MutationObserver | null = null;
  currentNavIndex = 0;
  isAtActiveSection = false;

  readonly servicePledgeText = 'It is our pledge to render careful, professional cleaning services using reasonable care to obtain satisfactory results. We do not guarantee all leaks or cracks in any type of roof material will be discovered. Factors of installation and/or deterioration that are disguised or covered cannot be predicted in the hands of even the most careful workman. Gutters that are rusted and/or brittle can potentially leak or break during a cleaning process. We do guarantee that we will be careful to clean the roof in a manner that will reduce the risk of any of these instances.';
  readonly datesOfServiceText = 'All dates subject to change based on weather and other unforeseen circumstances. You will be notified as soon as possible if services need to be rescheduled. There is no exact time of arrival for these dates.';
  readonly authorizationText = 'By signing this you are acknowledging that you are authorizing The Roof Medic to perform all services that are indicated on this form and are agreeing to pay the prices quoted on this form for those services (plus sales tax, minus any discounts noted on this form) within 15 days of all services being completed (unless otherwise stated on this form). Late Fees will begin accumulating at a rate of 1.5% per month on any unpaid balance after the due date. You also agree to review the Pre-Cleaning Service Recommendations sheet provided and understand that you are responsible for any property preparations listed on that sheet as well as any rescheduling and/or cancellation fees and requirements noted on that sheet. In the event of legal action to collect sums due under this contract, The Roof Medic will be entitled to reasonable attorney fees and cost in addition to the contact amount. We may withdraw this proposal if not accepted in 30 days.';

  readonly summaryFieldDefs: EstimateFieldDefinition[] = [
    { label: 'Job #', fid: 3 },
    { label: 'Status', fid: 11 },
    { label: 'Stage', fid: 40 },
    { label: 'Service Date', fid: 9 },
    { label: 'Service Type', fid: 15 },
    { label: 'Service Subtype', fid: 16 },
    { label: 'Expected Between', fid: 44 },
    { label: 'Stop', fid: 108 },
    { label: 'Roof Type', fid: 70 },
    { label: 'Pitch', fid: 110 },
    { label: 'Height (Stories/Floors)', fid: 46 },
    { label: 'Roof Maintenance', fid: 71 },
    { label: 'Campaign Name', fid: 26 },
  ];

  readonly inspectionFieldDefs: EstimateFieldDefinition[] = [
    { label: 'Flashings Needing Service', fid: 153 },
    { label: 'Penetrations / Leaks', fid: 48 },
    { label: 'Field Condition', fid: 49 },
    { label: 'Ridge Condition', fid: 50 },
    { label: 'Boots Needed', fid: 51, boolean: true },
    { label: 'Boot Qty 1.5', fid: 52 },
    { label: 'Boot Qty 2', fid: 56 },
    { label: 'Boot Qty 3', fid: 57 },
    { label: 'Vents Needed', fid: 55, boolean: true },
    { label: 'AF50 Vent Qty', fid: 53 },
    { label: 'BF4 Vent Qty', fid: 59 },
    { label: 'BF6 Vent Qty', fid: 58 },
  ];

  readonly groundInspectionFieldDefs: EstimateFieldDefinition[] = [
    { label: 'Fascia & Soffit', fid: 118 },
    { label: 'Gutters', fid: 120 },
    { label: 'Downspouts & Extensions', fid: 121 },
    { label: 'Siding/Exterior Walls', fid: 122 },
    { label: 'Doors & Windows', fid: 123 },
    { label: 'Foundation/Grading', fid: 124 },
    { label: 'Driveway/Walkway', fid: 125 },
    { label: 'Perimeter Safety Hazards', fid: 126 },
  ];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService,
    private alertController: AlertController,
    private loadingService: LoadingService
  ) {
    addIcons({ trash });
  }

  ngOnInit() {
    this.jobId = String(this.route.snapshot.paramMap.get('jobId') || '').trim();
    const navState = this.router.getCurrentNavigation()?.extras?.state as {
      job?: any;
      inspectionCache?: any;
      isEstimateRevision?: boolean;
      isHistoricalRetrieval?: boolean;
      workflow?: EstimateWorkflow;
    } | undefined;
    const historyState = history.state as {
      job?: any;
      inspectionCache?: any;
      isEstimateRevision?: boolean;
      isHistoricalRetrieval?: boolean;
      workflow?: EstimateWorkflow;
    } | undefined;

    this.job = navState?.job || historyState?.job || null;
    this.isEstimateRevision = (navState?.isEstimateRevision || historyState?.isEstimateRevision) === true;
    const isHistoricalRetrieval = (navState?.isHistoricalRetrieval || historyState?.isHistoricalRetrieval) === true;
    const workflow: EstimateWorkflow = navState?.workflow || historyState?.workflow || EstimateWorkflow.START;

    if (!this.job && this.jobId) {
      this.job = { '3': { value: this.jobId } };
    }

    this.inspectionCache = navState?.inspectionCache || historyState?.inspectionCache || this.readInspectionCache(this.jobId);

    console.log('[EstimateInit] Incoming router state:', {
      workflow,
      isEstimateRevision: this.isEstimateRevision,
      isHistoricalRetrieval,
      inspectionCacheSource: navState?.inspectionCache ? 'navState' : historyState?.inspectionCache ? 'historyState' : 'readInspectionCache',
      inspectionCacheKeys: this.inspectionCache ? Object.keys(this.inspectionCache) : null,
      inspectionCachePhotoCount: this.inspectionCache?.photoBatchData?.rows?.length || 0,
      inspectionCacheMasterValues: this.inspectionCache?.masterJobRecordValues ? Object.keys(this.inspectionCache.masterJobRecordValues) : null,
    });

    void this.initializeEstimateData(workflow, isHistoricalRetrieval);
  }

  get hasNavigableEstimateSections(): boolean {
    return this.getExistingNavSections().length > 1;
  }

  private getExistingNavSections(): HTMLElement[] {
    return this.sectionNavIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
  }

  async ngAfterViewInit() {
    await this.setupSectionNavObserver();
  }

  ngOnDestroy() {
    this.disconnectSectionNavObserver();
  }

  private async setupSectionNavObserver() {
    this.disconnectSectionNavObserver();

    const content = document.querySelector('ion-content.estimate-page') as HTMLIonContentElement | null;
    if (!content) {
      return;
    }

    const root = await content.getScrollElement();
    const sections = this.getExistingNavSections();
    if (sections.length === 0) {
      return;
    }

    this.sectionNavObserver = new IntersectionObserver(
      (entries) => this.handleSectionNavIntersection(entries),
      {
        root,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    );

    for (const section of sections) {
      this.sectionNavObserver.observe(section);
    }

    this.sectionNavMutationObserver = new MutationObserver(() => {
      void this.setupSectionNavObserver();
    });
    this.sectionNavMutationObserver.observe(content, { childList: true, subtree: true });
  }

  private handleSectionNavIntersection(entries: IntersectionObserverEntry[]) {
    let bestIndex = this.currentNavIndex;
    let bestRatio = 0;

    for (const entry of entries) {
      const index = this.sectionNavIds.indexOf(entry.target.id);
      if (index < 0) {
        continue;
      }
      if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
        bestRatio = entry.intersectionRatio;
        bestIndex = index;
      }
    }

    if (bestRatio > 0) {
      this.currentNavIndex = bestIndex;
      this.isAtActiveSection = this.currentNavIndex === this.activeSectionNavIndex;
    }
  }

  navigateNextSection() {
    const sections = this.getExistingNavSections();
    if (sections.length === 0) {
      return;
    }

    const existingIds = sections.map((s) => s.id);

    let targetIndex: number;
    if (this.currentNavIndex === this.activeSectionNavIndex) {
      // At Active Estimate Items: return to the first section.
      targetIndex = 0;
    } else {
      // Move to the next existing section in DOM order.
      targetIndex = this.currentNavIndex + 1;
      while (targetIndex < this.sectionNavIds.length && !existingIds.includes(this.sectionNavIds[targetIndex])) {
        targetIndex++;
      }
      // Wrap back to the first section if no later section exists.
      if (targetIndex >= this.sectionNavIds.length) {
        targetIndex = 0;
      }
    }

    const targetId = this.sectionNavIds[targetIndex];
    const target = document.getElementById(targetId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    this.currentNavIndex = targetIndex;
    this.isAtActiveSection = this.currentNavIndex === this.activeSectionNavIndex;
  }

  private disconnectSectionNavObserver() {
    if (this.sectionNavObserver) {
      this.sectionNavObserver.disconnect();
      this.sectionNavObserver = null;
    }
    if (this.sectionNavMutationObserver) {
      this.sectionNavMutationObserver.disconnect();
      this.sectionNavMutationObserver = null;
    }
  }

  ionViewDidEnter() {
    this.refreshSignatureCanvas();
  }

  ngDoCheck() {
    this.persistEstimateDraftIfChanged();
  }

  private refreshSummaryViewModel() {
    this.summaryFields = this.getSummaryFields();
    this.inspectionFields = this.getInspectionFields();
    this.groundInspectionFields = this.getGroundInspectionFields();
  }

  private hasEstimateLookupFields(): boolean {
    return !!(this.getFieldValue(142) || this.getFieldValue(15));
  }

  private async initializeEstimateData(workflow: EstimateWorkflow, isHistoricalRetrieval: boolean) {
    // Prevent draft persistence during initialization
    this.skipDraftPersistence = true;

    console.log('[EstimateInit] initializeEstimateData start:', {
      workflow,
      isHistoricalRetrieval,
      inspectionCachePhotoCount: this.inspectionCache?.photoBatchData?.rows?.length || 0,
      cachedInspectionPhotosBefore: this.cachedInspectionPhotos.length,
      inspectionHubRoofTilesBefore: this.inspectionHubRoofTiles.length,
    });

    if (this.jobId && !this.hasEstimateLookupFields()) {
      const detailedJob = await this.authService.getJobDetail(this.jobId);
      if (detailedJob) {
        this.job = detailedJob;
      }
    }

    this.applyInspectionCacheToJob(this.inspectionCache);
    this.hydrateSubmissionStateFromJob();
    this.refreshSummaryViewModel();
    const catalogLoadPromise = this.loadOfferedServiceItems();

    console.log('[EstimateInit] After applyInspectionCacheToJob:', {
      hasJob: !!this.job,
      locationId: this.getRelatedLocationId(),
      inspectionCachePhotoCount: this.inspectionCache?.photoBatchData?.rows?.length || 0,
    });

    if (!isHistoricalRetrieval) {
      this.hydrateRoofTilesFromCache();
      console.log('[EstimateInit] After hydrateRoofTilesFromCache:', {
        inspectionHubRoofTilesAfterHydrate: this.inspectionHubRoofTiles.length,
      });

      // Both operations are awaited so that all async initialization state is
      // fully settled before cachedInspectionPhotos is assigned and the workflow
      // branch runs. This produces a single deterministic initialization sequence.
      await this.loadInspectionPhotosFromIndexedDb();
      console.log('[EstimateInit] After loadInspectionPhotosFromIndexedDb:', {
        indexedDbInspectionPhotosCount: this.indexedDbInspectionPhotos.length,
      });

      await this.loadInspectionHubRoofs();
      console.log('[EstimateInit] After loadInspectionHubRoofs:', {
        inspectionHubRoofTilesAfterLoad: this.inspectionHubRoofTiles.length,
      });

      // Single authoritative assignment of cachedInspectionPhotos. Both
      // indexedDbInspectionPhotos and inspectionHubRoofTiles are fully populated
      // at this point. Draft hydration in the workflow branch below will have a
      // complete photo collection to work against.
      this.cachedInspectionPhotos = this.getCachedInspectionPhotos();
      console.log('[EstimateInit] After getCachedInspectionPhotos:', {
        cachedInspectionPhotosCount: this.cachedInspectionPhotos.length,
      });
    }

    if (workflow === EstimateWorkflow.RESUME) {
      // RESUME: always restore from draft. No retrieval. No reconstruction.
      if (this.hasEstimateDraft()) {
        console.log('[EstimateInit] RESUME: restoring from draft');
        await this.hydrateEstimateDraftIfPresent();
      } else {
        // Missing draft on RESUME is a workflow error - return user to dashboard
        console.error('[EstimateInit] RESUME: no draft found - workflow error, returning to dashboard');
        this.skipDraftPersistence = false;
        this.router.navigate(['/home']);
        return;
      }
    } else if (workflow === EstimateWorkflow.REVISE) {
      // REVISE: restore draft if present, else reconstruct once from QuickBase
      if (this.hasEstimateDraft()) {
        console.log('[EstimateInit] REVISE: draft exists, restoring from draft');
        await this.hydrateEstimateDraftIfPresent();
      } else {
        console.log('[EstimateInit] REVISE: no draft, reconstructing from QuickBase');
        await catalogLoadPromise;
        await this.reconstructEstimateFromQuickBase();
      }
    } else {
      // START: use inspection cache (already provided by HomePage, local or historical)
      console.log('[EstimateInit] START branch entered:', {
        isHistoricalRetrieval,
        cachedInspectionPhotosCount: this.cachedInspectionPhotos.length,
        inspectionHubRoofTilesCount: this.inspectionHubRoofTiles.length,
      });
      // No draft restoration, no reconstruction. Inspection cache already applied above.
    }

    // Initialize lastDraftSnapshot so ngDoCheck only saves after an actual user modification
    this.lastDraftSnapshot = JSON.stringify(this.buildEstimateDraftData());

    // Re-enable draft persistence after initialization completes
    this.skipDraftPersistence = false;
  }

  private async loadInspectionPhotosFromIndexedDb() {
    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId || !this.isIndexedDbAvailable()) {
      return;
    }

    const db = await this.openInspectionDraftDb();
    if (!db) {
      return;
    }

    try {
      const row = await new Promise<any>((resolve, reject) => {
        const tx = db.transaction(EstimatePage.INSPECTION_PHOTO_STORE_NAME, 'readonly');
        const store = tx.objectStore(EstimatePage.INSPECTION_PHOTO_STORE_NAME);
        const request = store.get(serviceOrderId);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('IndexedDB photo draft read failed.'));
      });

      console.log('[EstimateInit] loadInspectionPhotosFromIndexedDb raw row:', {
        serviceOrderId,
        hasRow: !!row,
        rowKeys: row ? Object.keys(row) : null,
        inspectionPhotoStateKeys: row?.inspectionPhotoState ? Object.keys(row.inspectionPhotoState) : null,
        estimatePhotoStateCount: row?.estimatePhotoState?.length || 0,
      });

      this.indexedDbInspectionPhotos = this.buildCachedPhotosFromSerializedState(row?.inspectionPhotoState);
      console.log('[EstimateInit] loadInspectionPhotosFromIndexedDb parsed count:', this.indexedDbInspectionPhotos.length);
    } catch (error) {
      console.warn('Failed loading inspection photos from IndexedDB in Estimate page.', error);
      this.indexedDbInspectionPhotos = [];
    } finally {
      db.close();
    }
  }

  private buildCachedPhotosFromSerializedState(state: any): CachedInspectionPhoto[] {
    if (!state || typeof state !== 'object') {
      return [];
    }

    const photos: CachedInspectionPhoto[] = [];
    for (const sectionKey of Object.keys(state || {})) {
      const sectionPhotos = Array.isArray(state?.[sectionKey]) ? state[sectionKey] : [];
      for (const photo of sectionPhotos) {
        const dataUrl = String(photo?.dataUrl || '').trim();
        if (!dataUrl) {
          continue;
        }

        photos.push({
          id: this.generatePhotoId(dataUrl),
          src: dataUrl,
          section: this.toPhotoSectionLabel(sectionKey),
          notes: String(photo?.notes || '').trim(),
        });
      }
    }

    return photos;
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
        EstimatePage.INSPECTION_DRAFT_DB_NAME,
        EstimatePage.INSPECTION_DRAFT_DB_VERSION
      );

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EstimatePage.INSPECTION_PHOTO_STORE_NAME)) {
          db.createObjectStore(EstimatePage.INSPECTION_PHOTO_STORE_NAME, {
            keyPath: 'serviceOrderId',
          });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('Unable to open IndexedDB for estimate inspection photos.', request.error);
        resolve(null);
      };
    });
  }

  private async persistEstimatePhotosToIndexedDbIfChanged() {
    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId || !this.isIndexedDbAvailable()) {
      return;
    }

    const snapshot = JSON.stringify(this.cachedInspectionPhotos);
    if (snapshot === this.lastEstimatePhotoSnapshot) {
      return;
    }

    const db = await this.openInspectionDraftDb();
    if (!db) {
      return;
    }

    try {
      const existing = await new Promise<any>((resolve, reject) => {
        const tx = db.transaction(EstimatePage.INSPECTION_PHOTO_STORE_NAME, 'readonly');
        const store = tx.objectStore(EstimatePage.INSPECTION_PHOTO_STORE_NAME);
        const request = store.get(serviceOrderId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('IndexedDB estimate photo read failed.'));
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(EstimatePage.INSPECTION_PHOTO_STORE_NAME, 'readwrite');
        const store = tx.objectStore(EstimatePage.INSPECTION_PHOTO_STORE_NAME);
        store.put({
          serviceOrderId,
          inspectionPhotoState: existing?.inspectionPhotoState || null,
          estimatePhotoState: this.cachedInspectionPhotos,
          updatedAt: Date.now()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB estimate photo write failed.'));
      });

      this.lastEstimatePhotoSnapshot = snapshot;
    } catch (error) {
      console.warn('[Estimate] Failed to persist estimate photos in IndexedDB.', error);
    } finally {
      db.close();
    }
  }

  private async loadEstimatePhotosFromIndexedDb() {
    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId || !this.isIndexedDbAvailable()) {
      return;
    }

    const db = await this.openInspectionDraftDb();
    if (!db) {
      return;
    }

    try {
      const row = await new Promise<any>((resolve, reject) => {
        const tx = db.transaction(EstimatePage.INSPECTION_PHOTO_STORE_NAME, 'readonly');
        const store = tx.objectStore(EstimatePage.INSPECTION_PHOTO_STORE_NAME);
        const request = store.get(serviceOrderId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('IndexedDB estimate photo read failed.'));
      });

      if (Array.isArray(row?.estimatePhotoState) && this.cachedInspectionPhotos.length === 0) {
        this.cachedInspectionPhotos = row.estimatePhotoState;
        this.lastEstimatePhotoSnapshot = JSON.stringify(this.cachedInspectionPhotos);
      }
    } catch (error) {
      console.warn('[Estimate] Failed to load estimate photos from IndexedDB.', error);
    } finally {
      db.close();
    }
  }

  private hydrateSubmissionStateFromJob() {
    const resolvedEmail = this.getFieldValue(142) || this.getFieldValue(57) || this.locationEmail;
    this.locationEmail = resolvedEmail;
    this.customerRecordId = this.getFieldValue(15) || this.customerRecordId;
    this.locationRecordId = this.getLocationRecordId();
    this.discountsAvailable = this.isTruthyField(131, this.job);
    this.discountControlValue = this.getFieldValue(138) || this.discountControlValue;
    this.secondaryDiscountAmount = this.sanitizeCurrencyInput(
      this.getFieldValue(139) || this.getFieldValue(83) || this.secondaryDiscountAmount
    );
    this.secondaryDiscountPercentage = this.sanitizeCurrencyInput(
      this.getFieldValue(140) || this.getFieldValue(39) || this.secondaryDiscountPercentage
    );
  }

  async loadOfferedServiceItems() {
    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId) {
      this.catalogItems = [];
      return;
    }

    this.isCatalogLoading = true;
    try {
      const offeredItems = await this.authService.getOfferedServiceItems(serviceOrderId);
      const safeItems = Array.isArray(offeredItems) ? offeredItems : [];
      this.catalogItems = safeItems.map((item) => this.toCatalogItem(item));
      this.refreshCatalogViewModel();
    } finally {
      this.isCatalogLoading = false;
    }
  }

  private refreshCatalogViewModel() {
    this.packageSections = this.buildPackageSections();
    this.tipTopRoofCareClubItems = this.buildTipTopRoofCareClubItems();
    this.categorizedRepairGroups = this.buildCategorizedRepairGroups();
    this.refreshFilteredCatalogItems();
  }

  private toCatalogItem(item: OfferedServiceItem): EstimateCatalogItem {
    return {
      id: Number(item.id) || 0,
      name: String(item.name || '').trim(),
      description: String(item.description || '').trim(),
      category: String(item.category || '').trim(),
      serviceType: String(item.serviceType || '').trim(),
      unit: String(item.unit || '').trim(),
      price: Number.isFinite(Number(item.price)) ? Number(item.price) : 0,
      isPackage: !!item.isPackage,
      packageTier: String(item.packageTier || '').trim(),
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : 0,
    };
  }

  private hydrateRoofTilesFromCache() {
    const cachedRoofs = Array.isArray(this.inspectionCache?.roofs) ? this.inspectionCache.roofs : [];
    console.log('[EstimateInit] hydrateRoofTilesFromCache:', {
      inspectionCacheHasRoofs: Array.isArray(this.inspectionCache?.roofs),
      cachedRoofCount: cachedRoofs.length,
    });

    if (cachedRoofs.length === 0) {
      this.inspectionHubRoofTiles = [];
      this.selectedRoofSquareFootage = 0;
      return;
    }

    this.inspectionHubRoofTiles = this.toInspectionRoofTiles(cachedRoofs);
    this.selectedRoofSquareFootage = this.computeSelectedRoofSquareFootage();
  }

  private async loadInspectionHubRoofs() {
    let locationId = this.getRelatedLocationId();
    console.log('[EstimateInit] loadInspectionHubRoofs start:', { locationId, hasJob: !!this.job });

    if (!locationId) {
      const jobRecordId = this.getJobRecordId();
      console.log('[EstimateInit] loadInspectionHubRoofs no locationId, fetching job detail:', { jobRecordId });
      if (jobRecordId) {
        const detailedJob = await this.authService.getJobDetail(jobRecordId);
        if (detailedJob) {
          this.job = detailedJob;
          this.applyInspectionCacheToJob(this.inspectionCache);
          this.refreshSummaryViewModel();
          locationId = this.getRelatedLocationId();
          console.log('[EstimateInit] loadInspectionHubRoofs after job detail:', { locationId });
        }
      }
    }

    if (!locationId) {
      console.log('[EstimateInit] loadInspectionHubRoofs still no locationId, aborting');
      return;
    }

    this.roofsLoading = true;
    try {
      const roofs = await this.authService.getRoofsByLocation(locationId);
      console.log('[EstimateInit] loadInspectionHubRoofs fetched roofs:', { locationId, roofCount: Array.isArray(roofs) ? roofs.length : 0 });
      if (!Array.isArray(roofs) || roofs.length === 0) {
        return;
      }

      const nextTiles = this.toInspectionRoofTiles(roofs);
      const selectedIds = new Set(this.inspectionHubRoofTiles.filter((tile) => tile.isAdded).map((tile) => tile.id));
      this.inspectionHubRoofTiles = nextTiles.map((tile) => ({
        ...tile,
        isAdded: selectedIds.has(tile.id),
      }));
      this.selectedRoofSquareFootage = this.computeSelectedRoofSquareFootage();
      this.recomputeActiveEstimateItems();
      this.persistRoofsToInspectionCache(roofs);
      console.log('[EstimateInit] loadInspectionHubRoofs mapped tiles:', { tileCount: this.inspectionHubRoofTiles.length });
    } finally {
      this.roofsLoading = false;
    }
  }

  private getRelatedLocationId(): string {
    const fid7 = this.getFieldValue(7);
    const fid6 = this.getFieldValue(6);
    const fid90 = this.getFieldValue(90);
    return (fid7 || fid6 || fid90 || '').toString().trim();
  }

  private toInspectionRoofTiles(roofs: any[]): InspectionRoofTile[] {
    return (roofs || [])
      .map((roof, index) => {
        const id = String(roof?.['3']?.value || '').trim();
        const name = String(roof?.['60']?.value || '').trim() || 'Unnamed Roof';
        const squareFootage = this.parseSquareFootage(roof?.['61']?.value);
        return {
          __index: index,
          id,
          name,
          material: String(roof?.['69']?.value || '').trim() || '-',
          pitch: String(roof?.['63']?.value || '').trim() || '-',
          squareFootage,
          squareFootageLabel: squareFootage > 0 ? `${squareFootage} sq ft` : '-',
          type: String(roof?.['67']?.value || '').trim() || '-',
          status: String(roof?.['59']?.value || '').trim() || '-',
          isAdded: false,
        } as InspectionRoofTile;
      })
      .filter((tile) => !!tile.id)
      .sort((left: InspectionRoofTile & { __index?: number }, right: InspectionRoofTile & { __index?: number }) => {
        const leftIsHome = this.isHomeRoofTile(left);
        const rightIsHome = this.isHomeRoofTile(right);

        if (leftIsHome !== rightIsHome) {
          return leftIsHome ? -1 : 1;
        }

        return Number(left.__index || 0) - Number(right.__index || 0);
      })
      .map((tile) => {
        const { __index, ...nextTile } = tile as InspectionRoofTile & { __index?: number };
        return nextTile as InspectionRoofTile;
      });
  }

  private isHomeRoofTile(tile: { name?: string }): boolean {
    return this.normalizeText(tile?.name || '').startsWith('home');
  }

  private parseSquareFootage(value: any): number {
    const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return Math.round(parsed);
  }

  private computeSelectedRoofSquareFootage(): number {
    return this.inspectionHubRoofTiles.reduce((total, tile) => {
      return tile.isAdded ? total + tile.squareFootage : total;
    }, 0);
  }

  addAllRoofsToEstimate() {
    if (this.inspectionHubRoofTiles.length === 0) {
      return;
    }

    this.inspectionHubRoofTiles = this.inspectionHubRoofTiles.map((tile) => ({
      ...tile,
      isAdded: true,
    }));
    this.selectedRoofSquareFootage = this.computeSelectedRoofSquareFootage();
    this.recomputeActiveEstimateItems();
  }

  addRoofToEstimate(roofId: string) {
    let didUpdate = false;
    this.inspectionHubRoofTiles = this.inspectionHubRoofTiles.map((tile) => {
      if (tile.id !== roofId || tile.isAdded) {
        return tile;
      }

      didUpdate = true;
      return {
        ...tile,
        isAdded: true,
      };
    });

    if (!didUpdate) {
      return;
    }

    this.selectedRoofSquareFootage = this.computeSelectedRoofSquareFootage();
    this.recomputeActiveEstimateItems();
  }

  get hasInspectionHubRoofTiles(): boolean {
    return this.inspectionHubRoofTiles.length > 0;
  }

  private persistRoofsToInspectionCache(roofs: any[]) {
    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId) {
      return;
    }

    const nextCache = {
      ...(this.inspectionCache || {}),
      serviceOrderId,
      roofs: Array.isArray(roofs) ? roofs : [],
      cachedAt: new Date().toISOString(),
    };

    // Always use compact cache for localStorage to avoid quota issues with photos
    const compactCache = {
      ...nextCache,
      photoBatchData: { tableId: 'bv3mp7tra', rows: [] },
      photoCount: Number(nextCache?.photoCount || 0),
    };

    const storageKey = this.getInspectionCacheStorageKey(serviceOrderId);

    // Keep full cache (with photos) in memory for rendering
    this.inspectionCache = nextCache;

    // Only persist compact cache (without photos) to localStorage
    try {
      localStorage.setItem(storageKey, JSON.stringify(compactCache));
    } catch (error) {
      if (this.isStorageQuotaExceededError(error)) {
        console.warn('Inspection cache exceeded localStorage quota even with compact payload. Continuing without local cache update.', {
          serviceOrderId,
        });
      } else {
        console.warn('Failed to persist roofs into inspection cache.', error);
      }
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

  private getTodayDateInputValue(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private hasEstimateDraft(): boolean {
    const storageKey = this.getEstimateDraftStorageKey();
    return !!localStorage.getItem(storageKey);
  }

  private normalizeText(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  private toTitleCase(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private isTipTopClubItem(item: EstimateCatalogItem): boolean {
    const source = `${item.category} ${item.name}`.toLowerCase();
    return source.includes('tip-top roof care club') || source.includes('tip top roof care club');
  }

  private isPackageType(item: EstimateCatalogItem): boolean {
    const value = this.normalizeText(item.serviceType);
    return value.startsWith('package');
  }

  private isNonPackageType(item: EstimateCatalogItem): boolean {
    const value = this.normalizeText(item.serviceType);
    return value.startsWith('non-package');
  }

  private isPackageLikeItem(item: EstimateCatalogItem): boolean {
    if (this.isNonPackageType(item)) {
      return false;
    }

    if (this.isPackageType(item)) {
      return true;
    }

    if (item.isPackage) {
      return true;
    }

    const category = this.normalizeText(item.category);
    const serviceType = this.normalizeText(item.serviceType);
    return (
      category.includes('budget') ||
      category.includes('value') ||
      category.includes('basic maintenance') ||
      category.includes('package') ||
      serviceType.includes('good') ||
      serviceType.includes('better') ||
      serviceType.includes('best')
    );
  }

  private getTierRank(item: EstimateCatalogItem): number {
    const source = `${item.packageTier} ${item.serviceType}`.toLowerCase();
    if (source.includes('good')) {
      return 1;
    }
    if (source.includes('better')) {
      return 2;
    }
    if (source.includes('best')) {
      return 3;
    }
    return 99;
  }

  private getPackageSectionLabel(category: string): string {
    const normalized = this.normalizeText(category);
    if (normalized.includes('budget')) {
      return 'Budget';
    }
    if (normalized.includes('value')) {
      return 'Value';
    }
    if (normalized.includes('basic maintenance')) {
      return 'Basic Maintenance';
    }
    return this.toTitleCase(category || 'Packages');
  }

  private buildPackageSections(): EstimatePackageSection[] {
    const grouped = new Map<string, EstimateCatalogItem[]>();

    for (const item of this.catalogItems) {
      if (!this.isPackageLikeItem(item) || this.isTipTopClubItem(item)) {
        continue;
      }

      const sectionLabel = this.getPackageSectionLabel(item.category);
      const sectionItems = grouped.get(sectionLabel) || [];
      sectionItems.push(item);
      grouped.set(sectionLabel, sectionItems);
    }

    const orderedSections = Array.from(grouped.entries()).map(([label, items]) => ({
      label,
      items: items.sort((left, right) => {
        const tierRank = this.getTierRank(left) - this.getTierRank(right);
        if (tierRank !== 0) {
          return tierRank;
        }

        return left.name.localeCompare(right.name);
      }),
    }));

    return orderedSections.sort((left, right) => {
      const leftIndex = EstimatePage.PACKAGE_SECTION_ORDER.indexOf(left.label);
      const rightIndex = EstimatePage.PACKAGE_SECTION_ORDER.indexOf(right.label);
      const safeLeft = leftIndex === -1 ? 99 : leftIndex;
      const safeRight = rightIndex === -1 ? 99 : rightIndex;
      if (safeLeft !== safeRight) {
        return safeLeft - safeRight;
      }
      return left.label.localeCompare(right.label);
    });
  }

  private buildTipTopRoofCareClubItems(): EstimateCatalogItem[] {
    return this.catalogItems
      .filter((item) => this.isTipTopClubItem(item))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private buildCategorizedRepairGroups(): EstimateCategoryGroup[] {
    const nonPackageItems = this.catalogItems.filter((item) => !this.isPackageLikeItem(item) && !this.isTipTopClubItem(item));
    const groupMap = new Map<string, EstimateCatalogItem[]>();

    for (const item of nonPackageItems) {
      const key = item.category || 'General Repairs';
      const groupItems = groupMap.get(key) || [];
      groupItems.push(item);
      groupMap.set(key, groupItems);
    }

    return Array.from(groupMap.entries())
      .map(([label, items]) => ({
        label,
        items: items.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  private refreshFilteredCatalogItems() {
    const term = this.serviceSearchTerm.trim().toLowerCase();
    if (!term) {
      this.filteredCatalogItems = [];
      return;
    }

    this.filteredCatalogItems = this.catalogItems.filter((item) => {
      const searchBlob = [item.name, item.description, item.category, item.packageTier]
        .join(' ')
        .toLowerCase();
      return searchBlob.includes(term);
    });
  }

  onServiceSearchTermChange(value: string) {
    this.serviceSearchTerm = value;
    this.refreshFilteredCatalogItems();
  }

  getCartItemCount(): number {
    return this.activeEstimateItems.reduce((total, item) => total + (item.qtyNeeded || 0), 0);
  }

  getCartSubtotal(): number {
    return this.activeEstimateItems.reduce((total, item) => total + item.lineSubtotal, 0);
  }

  getCartDiscountTotal(): number {
    return Math.min(this.getCartSubtotal(), this.getMSDiscountValue() + this.getOtherDiscountValue());
  }

  getCartTaxableSubtotal(): number {
    return Math.max(0, this.getCartSubtotal() - this.getCartDiscountTotal());
  }

  getCartTaxTotal(): number {
    const postalCode = this.getPostalCode();
    return this.roundCurrency(calculateTax(this.getCartTaxableSubtotal(), postalCode));
  }

  getCartGrandTotal(): number {
    return this.roundCurrency(this.getCartTaxableSubtotal() + this.getCartTaxTotal());
  }

  formatCurrency(value: number | null | undefined): string {
    const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `$${numericValue.toFixed(2)}`;
  }

  getCatalogItemCount(item: EstimateCatalogItem): number {
    const existing = this.activeEstimateItems.find((row) => row.id === item.id);
    return existing ? (existing.qtyNeeded || 0) : 0;
  }

  getCatalogDisplayText(item: { name?: string; description?: string }): string {
  const name = (item?.name || '').trim();
  const description = (item?.description || '').trim();

  if (!description) {
    return name;
  }

  return `${name} — ${description}`;
}

  addCatalogItemToEstimate(item: EstimateCatalogItem) {
    if (!item || !item.name) {
      return;
    }

    const existingIndex = this.activeEstimateItems.findIndex((row) => row.id === item.id);
    if (existingIndex >= 0) {
      const existing = this.activeEstimateItems[existingIndex];
      const updated: ActiveEstimateItem = {
        ...existing,
        qtyNeeded: (existing.qtyNeeded || 0) + 1,
      };
      this.recomputeItemPricing(updated);
      this.activeEstimateItems[existingIndex] = updated;
      this.syncPricingSummary();
      return;
    }

    const nextItem: ActiveEstimateItem = {
      ...item,
      qtyNeeded: 1,
      lineSubtotal: item.price,
      sqFootage: null,
    };
    this.recomputeItemPricing(nextItem);

    this.activeEstimateItems = [...this.activeEstimateItems, nextItem];
    this.syncPricingSummary();
  }

  removeCatalogItemFromEstimate(item: ActiveEstimateItem) {
    const targetIndex = this.activeEstimateItems.findIndex((row) => row.id === item.id);
    if (targetIndex < 0) {
      return;
    }

    this.activeEstimateItems = this.activeEstimateItems.filter((row) => row.id !== item.id);
    this.syncPricingSummary();
  }

  onActiveItemChanged(item: ActiveEstimateItem) {
    this.recomputeItemPricing(item);
    this.syncPricingSummary();
  }

  async selectAll(event: Event) {
    const target = event.target as HTMLIonInputElement | HTMLIonTextareaElement;
    try {
      const input = await target.getInputElement();
      input.select();
    } catch {
      // Selection is not supported on all mobile keyboards; ignore silently.
    }
  }

  async blurInput(event: Event) {
    const target = event.target as HTMLIonInputElement;
    try {
      const input = await target.getInputElement();
      input.blur();
    } catch {
      // Ignore blur failures for unsupported cases.
    }
  }

  onMSDiscountToggle(checked: boolean) {
    this.discountMS = !!checked;
    if (!this.discountMS) {
      this.msDiscountAmount = 0;
      this.msDiscountManuallyEdited = false;
      return;
    }

    this.msDiscountManuallyEdited = false;
    this.msDiscountAmount = this.getDefaultMSDiscountAmount();
  }

  onMSDiscountAmountChange(value: number | string | null | undefined) {
    this.msDiscountAmount = this.sanitizeCurrencyInput(value);
    this.msDiscountManuallyEdited = true;
  }

  onOtherDiscountToggle(checked: boolean) {
    this.discountOther = !!checked;
    if (!this.discountOther) {
      this.otherDiscountAmount = 0;
    }
  }

  onOtherDiscountAmountChange(value: number | string | null | undefined) {
    this.otherDiscountAmount = this.sanitizeCurrencyInput(value);
  }

  onSecondaryDiscountAmountChange(value: number | string | null | undefined) {
    this.secondaryDiscountAmount = this.sanitizeCurrencyInput(value);
  }

  onSecondaryDiscountPercentageChange(value: number | string | null | undefined) {
    this.secondaryDiscountPercentage = this.sanitizeCurrencyInput(value);
  }

  get hasCatalogItems(): boolean {
    return this.catalogItems.length > 0;
  }

  private recomputeItemPricing(item: ActiveEstimateItem) {
    const qty = Math.max(1, Number.parseInt(String(item.qtyNeeded), 10) || 1);
    const price = Math.max(0, Number(item.price) || 0);
    const sqFootage = Math.max(0, Number(item.sqFootage || this.selectedRoofSquareFootage || 0) || 0);
    const multiplier = this.isPerSquareUnit(item.unit) ? sqFootage : 1;
    const baseSubtotal = qty * price * multiplier;

    item.qtyNeeded = qty;
    item.price = price;
    item.sqFootage = sqFootage;
    item.lineSubtotal = baseSubtotal;
  }

  isPerSquareUnit(unit: string): boolean {
    const normalized = this.normalizeText(unit);
    return /\bsq\b/.test(normalized) || normalized.includes('square');
  }

  private recomputeActiveEstimateItems() {
    if (this.activeEstimateItems.length === 0) {
      return;
    }

    this.activeEstimateItems = this.activeEstimateItems.map((item) => {
      const nextItem = { ...item };
      this.recomputeItemPricing(nextItem);
      return nextItem;
    });
    this.syncPricingSummary();
  }

  private syncPricingSummary() {
    if (this.discountMS && !this.msDiscountManuallyEdited) {
      this.msDiscountAmount = this.getDefaultMSDiscountAmount();
    }
  }

  private getDefaultMSDiscountAmount(): number {
    return this.roundCurrency(this.getCartSubtotal() * 0.05);
  }

  getMSDiscountValue(): number {
    if (!this.discountMS) {
      return 0;
    }

    return Math.min(this.getCartSubtotal(), this.sanitizeCurrencyInput(this.msDiscountAmount));
  }

  getOtherDiscountValue(): number {
    if (!this.discountOther) {
      return 0;
    }

    return Math.min(this.getCartSubtotal(), this.sanitizeCurrencyInput(this.otherDiscountAmount));
  }

  getEstimatedTaxRate(): number {
    const postalCode = this.getPostalCode();
    return getTaxRate(postalCode);
  }

  getEstimatedTaxRateLabel(): string {
    const postalCode = this.getPostalCode();
    if (postalCode) {
      return `Postal code ${postalCode} estimated tax rate`;
    }

    const city = this.getFieldValue(92);
    const state = this.getFieldValue(104);
    if (city && state) {
      return `${city}, ${state} estimated tax rate`;
    }

    if (state) {
      return `${state} estimated tax rate`;
    }

    return 'Estimated tax rate';
  }

  private getPostalCode(): string {
    const rawPostal = this.getFieldValue(105);
    const match = String(rawPostal || '').match(/\d{5}/);
    return match ? match[0] : '';
  }

  private isTruthyField(fid: number, job: any = this.job): boolean {
    const value = this.getFieldValue(fid, job);
    const normalized = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'checked'].includes(normalized);
  }

  private getLocationRecordId(job: any = this.job): string {
    const candidates = [job?.['6']?.value, job?.['7']?.value, job?.['90']?.value, job?.['91']?.value];
    const recordId = candidates
      .map((value) => String(value || '').trim())
      .find((value) => /^\d+$/.test(value));

    return recordId || '';
  }

  private getSignatureCanvas(): HTMLCanvasElement | null {
    return this.signatureCanvasRef?.nativeElement || null;
  }

  private refreshSignatureCanvas() {
    const canvas = this.getSignatureCanvas();
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#1f2937';
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (this.signatureDataUrl) {
      const image = new Image();
      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      };
      image.src = this.signatureDataUrl;
    } else {
      this.signatureHasInk = false;
      this.signatureStrokeActive = false;
    }
  }

  private getSignaturePoint(event: PointerEvent) {
    const canvas = this.getSignatureCanvas();
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  beginSignatureStroke(event: PointerEvent) {
    const canvas = this.getSignatureCanvas();
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    const point = this.getSignaturePoint(event);
    if (!context || !point) {
      return;
    }

    this.signatureStrokeActive = true;
    this.signatureHasInk = true;
    canvas.setPointerCapture?.(event.pointerId);
    context.beginPath();
    context.moveTo(point.x, point.y);
    event.preventDefault();
  }

  continueSignatureStroke(event: PointerEvent) {
    if (!this.signatureStrokeActive) {
      return;
    }

    const canvas = this.getSignatureCanvas();
    const context = canvas?.getContext('2d');
    const point = this.getSignaturePoint(event);
    if (!canvas || !context || !point) {
      return;
    }

    context.lineTo(point.x, point.y);
    context.stroke();
    event.preventDefault();
  }

  endSignatureStroke() {
    if (!this.signatureStrokeActive) {
      return;
    }

    this.signatureStrokeActive = false;
    this.captureSignatureDataUrl();
  }

  clearSignaturePad() {
    const canvas = this.getSignatureCanvas();
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    this.signatureStrokeActive = false;
    this.signatureHasInk = false;
    this.signatureDataUrl = '';
  }

  private signatureDataUrl = '';

  private captureSignatureDataUrl() {
    const canvas = this.getSignatureCanvas();
    if (!canvas) {
      this.signatureDataUrl = '';
      return;
    }

    this.signatureDataUrl = this.signatureHasInk ? canvas.toDataURL('image/png') : '';
  }

  private hasSignatureData(): boolean {
    return !!this.signatureDataUrl;
  }

  private async promptForLocationEmail(existingEmail = ''): Promise<string | null> {
    const emailAlert = await this.alertController.create({
      header: 'Customer Email',
      message: 'Enter the customer email before submitting the estimate.',
      inputs: [
        {
          name: 'locationEmail',
          type: 'email',
          placeholder: 'location@example.com',
          value: existingEmail,
        },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', role: 'confirm' },
      ],
    });

    await emailAlert.present();
    const { role, data } = await emailAlert.onDidDismiss();
    if (role !== 'confirm') {
      return null;
    }

    return String(data?.values?.locationEmail || '').trim();
  }

  private async promptForSubmissionMode(): Promise<'estimated' | 'sold' | null> {
    const modeAlert = await this.alertController.create({
      header: 'Submit Estimate',
      message: 'Choose the customer path for this submission.',
      inputs: [
        {
          name: 'submissionMode',
          type: 'radio',
          label: 'Customer not present / undecided',
          value: 'estimated',
          checked: true,
        },
        {
          name: 'submissionMode',
          type: 'radio',
          label: 'Customer ready to begin',
          value: 'sold',
        },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', role: 'confirm' },
      ],
    });

    await modeAlert.present();
    const { role, data } = await modeAlert.onDidDismiss();
    if (role !== 'confirm') {
      return null;
    }

    const selectedMode = String(data?.values?.submissionMode || '').trim().toLowerCase();
    return selectedMode === 'sold' ? 'sold' : 'estimated';
  }

  private getEstimateSubmissionItems(): EstimateSubmissionPayloadItem[] {
    return this.activeEstimateItems.map((item) => ({
      id: Number.parseInt(String(item.id), 10) || 0,
      description: item.description
        ? `${item.name} — ${item.description}`
        : item.name,
      unit: String(item.unit || '').trim(),
      qtyNeeded: Math.max(1, Number(item.qtyNeeded) || 1),
      sqFootage: Number(item.sqFootage || this.selectedRoofSquareFootage || 0) || 0,
      price: Number(item.price) || 0,
      lineSubtotal: Number(item.lineSubtotal) || 0,
      amount: Number(item.lineSubtotal) || 0,
      uom: String(item.unit || '').trim(),
      specialInstructions: String(item.specialInstructions || '').trim(),
    }));
  }

  private getSelectedRoofRecordIds(): number[] {
    const roofIdsFromTiles = this.inspectionHubRoofTiles
      .filter((tile) => tile.isAdded)
      .map((tile) => Number.parseInt(String(tile.id), 10))
      .filter((value) => Number.isFinite(value));

    const roofIdsFromItems = this.activeEstimateItems
      .map((item: any) => Number.parseInt(String(item?.roofId || ''), 10))
      .filter((value) => Number.isFinite(value));

    return Array.from(new Set([...roofIdsFromTiles, ...roofIdsFromItems]));
  }

  private buildEstimateSubmissionPayload(submissionMode: 'estimated' | 'sold', locationEmail: string) {
    const customerFirstName = this.getFieldValue(93);
    const customerLastName = this.getFieldValue(94);
    const customerName = `${customerFirstName} ${customerLastName}`.trim();
    const addressStreet = this.getFieldValue(106);
    const addressCity = this.getFieldValue(92);
    const addressZip = this.getFieldValue(105);
    const locationAddress = `${addressStreet}, ${addressCity}, WA ${addressZip}`.trim();
    const customerPhone = this.getFieldValue(95);

    // Build roof structures data
    const roofStructures = this.inspectionHubRoofTiles
      .filter((tile) => tile.isAdded)
      .map((tile) => ({
        name: tile.name,
        material: tile.material,
        pitch: tile.pitch,
        squareFootage: tile.squareFootage,
      }));

    return {
      serviceOrderId: this.getJobRecordId(),
      locationRecordId: this.getLocationRecordId(),
      locationEmail,
      customerRecordId: this.customerRecordId,
      roofRecordIds: this.getSelectedRoofRecordIds(),
      submissionMode,
      customerReadyToBegin: submissionMode === 'sold',
      digitalSignatureDataUrl: submissionMode === 'sold' ? this.signatureDataUrl : '',
      activeEstimateItems: this.getEstimateSubmissionItems(),
      subtotal: this.getCartSubtotal(),
      taxAmount: this.getCartTaxTotal(),
      totalAmount: this.getCartGrandTotal(),
      secondaryDiscountAmount: this.getCartDiscountTotal(),
      secondaryDiscountPercentage: this.sanitizeCurrencyInput(this.secondaryDiscountPercentage),
      msDiscountAmount: this.getMSDiscountValue(),
      otherDiscountAmount: this.getOtherDiscountValue(),
      discountControlValue: this.discountControlValue,
      customerFirstName,
      customerName,
      locationAddress,
      customerPhone,
      roofStructures,
      totalSquareFootage: this.selectedRoofSquareFootage,
      serviceNotes: this.serviceNotes || '',
      cleanMaintenanceScheduledFor: this.cleanMaintenanceScheduledFor || '',
      repairServicesScheduledFor: this.repairServicesScheduledFor || '',
      isEstimateRevision: this.isEstimateRevision,
      inspectionPhotos: this.cachedInspectionPhotos.filter(photo => this.selectedPhotoIds.has(photo.id)),
    };
    console.log('[EstimatePayload] isEstimateRevision in payload:', this.isEstimateRevision);
  }

  async submitEstimate() {
    console.log('[Estimate Submit] Starting submission process');
    
    if (this.isSubmittingEstimate) {
      console.log('[Estimate Submit] Already submitting, returning');
      return;
    }

    if (!this.job || this.activeEstimateItems.length === 0) {
      console.log('[Estimate Submit] Missing job or no active items', {
        hasJob: !!this.job,
        itemCount: this.activeEstimateItems.length
      });
      return;
    }

    let locationEmail = this.locationEmail;
    if (!locationEmail) {
      console.log('[Estimate Submit] No location email, prompting user');
      const promptedEmail = await this.promptForLocationEmail();
      if (!promptedEmail) {
        console.log('[Estimate Submit] User cancelled email prompt');
        return;
      }
      locationEmail = promptedEmail;
      this.locationEmail = promptedEmail;
    }

    const submissionMode: 'estimated' | 'sold' = this.hasSignatureData() ? 'sold' : 'estimated';
    console.log('[Estimate Submit] Submission mode:', submissionMode);

    const locationRecordId = this.getLocationRecordId();
    if (!locationRecordId) {
      console.log('[Estimate Submit] Missing location record ID');
      const recordAlert = await this.alertController.create({
        header: 'Missing Location Record',
        message: 'Unable to resolve the related location record for this estimate.',
        buttons: ['OK'],
      });
      await recordAlert.present();
      return;
    }

    console.log('[Estimate Submit] All validations passed, preparing payload');
    this.isSubmittingEstimate = true;
    try {
      await this.loadingService.withLoading('Submitting estimate...', async () => {
        const payload = this.buildEstimateSubmissionPayload(submissionMode, locationEmail);
        console.log('[Estimate Submit] Payload built:', payload);
        const response = await this.authService.submitEstimateSubmission(payload);
        console.log('[Estimate Submit] Response received:', response);
        if (!response?.success) {
          throw new Error(response?.message || 'Estimate submission failed');
        }

        this.clearSignaturePad();
        if (submissionMode === 'sold') {
          // Signed submission: delete the draft and reminder per architecture
          this.clearEstimateDraft();
        } else {
          // Unsigned submission: persist a local reminder within the draft
          this.unsignedEstimateSubmitted = true;
          this.persistEstimateDraftIfChanged();
        }
        this.router.navigate(['/home']);
      });
    } catch (error) {
      console.error('Submit Estimate Error:', error);
      const errorAlert = await this.alertController.create({
        header: 'Submit Failed',
        message: 'The estimate could not be submitted. Check the console logs and try again.',
        buttons: ['OK'],
      });
      await errorAlert.present();
    } finally {
      this.isSubmittingEstimate = false;
    }
  }

  private sanitizeCurrencyInput(value: number | string | null | undefined): number {
    return Math.max(0, Number(value) || 0);
  }

  private roundCurrency(value: number): number {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  private getInspectionCacheStorageKey(serviceOrderId: string): string {
    return `${EstimatePage.INSPECTION_CACHE_PREFIX}${(serviceOrderId || '').trim()}`;
  }

  private generatePhotoId(dataUrl: string): string {
    // Simple hash function for generating stable IDs from dataUrl
    let hash = 0;
    for (let i = 0; i < dataUrl.length; i++) {
      const char = dataUrl.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `photo-${Math.abs(hash)}`;
  }

  private readInspectionCache(serviceOrderId: string): any | null {
    const id = (serviceOrderId || '').trim();
    if (!id) {
      return null;
    }

    const raw = localStorage.getItem(this.getInspectionCacheStorageKey(id));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private getEstimateDraftStorageKey(): string {
    const serviceOrderId = this.getJobRecordId();
    return `${EstimatePage.ESTIMATE_DRAFT_STORAGE_KEY_PREFIX}${(serviceOrderId || '').trim()}`;
  }

  private buildEstimateDraftData() {
    return {
      serviceOrderId: this.getJobRecordId(),
      unsignedEstimateSubmitted: this.unsignedEstimateSubmitted,
      activeEstimateItems: this.activeEstimateItems,
      formFields: {
        workOrderedBy: this.workOrderedBy,
        serviceNotes: this.serviceNotes,
        locationEmail: this.locationEmail,
        customerRecordId: this.customerRecordId,
        locationRecordId: this.locationRecordId,
        customerReadyToBegin: this.customerReadyToBegin,
        discountControlValue: this.discountControlValue,
        secondaryDiscountAmount: this.secondaryDiscountAmount,
        secondaryDiscountPercentage: this.secondaryDiscountPercentage,
        cleanMaintenanceScheduledFor: this.cleanMaintenanceScheduledFor,
        repairServicesScheduledFor: this.repairServicesScheduledFor,
        signatureDate: this.signatureDate,
        discountMS: this.discountMS,
        discountOther: this.discountOther,
        msDiscountAmount: this.msDiscountAmount,
        otherDiscountAmount: this.otherDiscountAmount
      },
      signatureDataUrl: this.signatureDataUrl,
      uiState: {
        serviceSearchTerm: this.serviceSearchTerm,
        selectedRoofSquareFootage: this.selectedRoofSquareFootage,
        inspectionHubRoofTiles: this.inspectionHubRoofTiles,
        selectedPhotoIds: Array.from(this.selectedPhotoIds)
      }
    };
  }

  private persistEstimateDraftIfChanged() {
    if (this.skipDraftPersistence) {
      return;
    }

    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId) {
      return;
    }

    try {
      const currentData = this.buildEstimateDraftData();
      const serialized = JSON.stringify(currentData);
      if (!serialized || serialized === this.lastDraftSnapshot) {
        return;
      }

      localStorage.setItem(this.getEstimateDraftStorageKey(), serialized);
      this.lastDraftSnapshot = serialized;
      void this.persistEstimatePhotosToIndexedDbIfChanged();
    } catch (error) {
      console.warn('[Estimate] Failed to persist local estimate draft.', error);
    }
  }

  private async hydrateEstimateDraftIfPresent() {
    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId) {
      return;
    }

    const storageKey = this.getEstimateDraftStorageKey();
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      this.unsignedEstimateSubmitted = parsed?.unsignedEstimateSubmitted ?? false;
      await this.loadEstimatePhotosFromIndexedDb();
      if (parsed?.activeEstimateItems && Array.isArray(parsed.activeEstimateItems)) {
        this.activeEstimateItems = parsed.activeEstimateItems;
      }

      if (parsed?.formFields && typeof parsed.formFields === 'object') {
        this.workOrderedBy = parsed.formFields.workOrderedBy || this.workOrderedBy;
        this.serviceNotes = parsed.formFields.serviceNotes || this.serviceNotes;
        this.locationEmail = parsed.formFields.locationEmail || this.locationEmail;
        this.customerRecordId = parsed.formFields.customerRecordId || this.customerRecordId;
        this.locationRecordId = parsed.formFields.locationRecordId || this.locationRecordId;
        this.customerReadyToBegin = parsed.formFields.customerReadyToBegin ?? this.customerReadyToBegin;
        this.discountControlValue = parsed.formFields.discountControlValue || this.discountControlValue;
        this.secondaryDiscountAmount = parsed.formFields.secondaryDiscountAmount ?? this.secondaryDiscountAmount;
        this.secondaryDiscountPercentage = parsed.formFields.secondaryDiscountPercentage ?? this.secondaryDiscountPercentage;
        this.cleanMaintenanceScheduledFor = parsed.formFields.cleanMaintenanceScheduledFor || this.cleanMaintenanceScheduledFor;
        this.repairServicesScheduledFor = parsed.formFields.repairServicesScheduledFor || this.repairServicesScheduledFor;
        this.signatureDate = parsed.formFields.signatureDate || this.signatureDate;
        this.discountMS = parsed.formFields.discountMS ?? this.discountMS;
        this.discountOther = parsed.formFields.discountOther ?? this.discountOther;
        this.msDiscountAmount = parsed.formFields.msDiscountAmount ?? this.msDiscountAmount;
        this.otherDiscountAmount = parsed.formFields.otherDiscountAmount ?? this.otherDiscountAmount;
      }

      if (parsed?.signatureDataUrl) {
        this.signatureDataUrl = parsed.signatureDataUrl;
        this.signatureHasInk = true;
      }

      if (parsed?.uiState && typeof parsed.uiState === 'object') {
        this.serviceSearchTerm = parsed.uiState.serviceSearchTerm || this.serviceSearchTerm;
        this.selectedRoofSquareFootage = parsed.uiState.selectedRoofSquareFootage ?? this.selectedRoofSquareFootage;
        if (Array.isArray(parsed.uiState.inspectionHubRoofTiles)) {
          this.inspectionHubRoofTiles = parsed.uiState.inspectionHubRoofTiles;
        }
        if (Array.isArray(parsed.uiState.cachedInspectionPhotos)) {
          this.cachedInspectionPhotos = parsed.uiState.cachedInspectionPhotos;
        }
        if (Array.isArray(parsed.uiState.selectedPhotoIds)) {
          this.selectedPhotoIds = new Set(parsed.uiState.selectedPhotoIds);
          this.selectAllPhotos = this.selectedPhotoIds.size > 0 && this.selectedPhotoIds.size === this.cachedInspectionPhotos.length;
        }
      }

      this.lastDraftSnapshot = JSON.stringify(this.buildEstimateDraftData());
      this.syncPricingSummary();
    } catch (error) {
      console.warn('[Estimate] Failed to hydrate local estimate draft. Clearing corrupt draft.', error);
      localStorage.removeItem(storageKey);
      this.lastDraftSnapshot = '';
    }
  }

  private async hydrateUiStateFromDraft() {
    const serviceOrderId = this.getJobRecordId();
    if (!serviceOrderId) {
      return;
    }

    const storageKey = this.getEstimateDraftStorageKey();
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed?.uiState && typeof parsed.uiState === 'object') {
        this.serviceSearchTerm = parsed.uiState.serviceSearchTerm || this.serviceSearchTerm;
        this.selectedRoofSquareFootage = parsed.uiState.selectedRoofSquareFootage ?? this.selectedRoofSquareFootage;
        if (Array.isArray(parsed.uiState.inspectionHubRoofTiles)) {
          this.inspectionHubRoofTiles = parsed.uiState.inspectionHubRoofTiles;
        }
        if (Array.isArray(parsed.uiState.selectedPhotoIds)) {
          this.selectedPhotoIds = new Set(parsed.uiState.selectedPhotoIds);
          this.selectAllPhotos = this.selectedPhotoIds.size > 0 && this.selectedPhotoIds.size === this.cachedInspectionPhotos.length;
        }
      }
      console.log('[Estimate] UI state restored from draft for revision');
    } catch (error) {
      console.warn('[Estimate] Failed to hydrate UI state from draft.', error);
    }
  }

  private clearEstimateDraft() {
    const storageKey = this.getEstimateDraftStorageKey();
    localStorage.removeItem(storageKey);
    this.clearSignaturePad();
    this.lastDraftSnapshot = '';
    this.skipDraftPersistence = true;
    setTimeout(() => {
      this.skipDraftPersistence = false;
    }, 5000);
  }

  async startOverEstimate() {
    const alert = await this.alertController.create({
      header: 'Start Over?',
      message: 'This will clear your current selections and reset the editing session. Your saved draft will not be deleted.',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel',
          cssClass: 'secondary'
        },
        {
          text: 'Start Over',
          role: 'destructive',
          handler: () => {
            this.resetEstimateToInitialState();
          }
        }
      ]
    });

    await alert.present();
  }

  private resetEstimateToInitialState() {
    this.activeEstimateItems = [];
    this.serviceSearchTerm = '';
    this.selectedRoofSquareFootage = 0;
    this.workOrderedBy = '';
    this.serviceNotes = '';
    this.customerReadyToBegin = false;
    this.discountControlValue = '';
    this.secondaryDiscountAmount = 0;
    this.secondaryDiscountPercentage = 0;
    this.discountMS = false;
    this.discountOther = false;
    this.msDiscountAmount = 0;
    this.otherDiscountAmount = 0;
    this.cleanMaintenanceScheduledFor = this.getTodayDateInputValue();
    this.repairServicesScheduledFor = this.getTodayDateInputValue();
    this.signatureDate = this.getTodayDateInputValue();
    this.clearSignaturePad();

    this.inspectionHubRoofTiles = this.inspectionHubRoofTiles.map((tile) => ({
      ...tile,
      isAdded: false
    }));

    this.syncPricingSummary();

    // Update the snapshot to the cleared state. Auto-save will not write anything
    // until the technician makes an actual edit, at which point the cleared state
    // naturally becomes the new draft through the existing persistence mechanism.
    this.lastDraftSnapshot = JSON.stringify(this.buildEstimateDraftData());
  }

  private applyInspectionCacheToJob(cache: any) {
    console.log('[EstimateInit] applyInspectionCacheToJob input:', {
      hasJob: !!this.job,
      hasCache: !!cache,
      cacheType: typeof cache,
      cacheKeys: cache ? Object.keys(cache) : null,
      masterJobRecordValueKeys: cache?.masterJobRecordValues ? Object.keys(cache.masterJobRecordValues) : null,
      photoBatchRowCount: cache?.photoBatchData?.rows?.length || 0,
    });

    if (!this.job || !cache || typeof cache !== 'object') {
      return;
    }

    const incomingValues: Record<string, any> = {};
    if (cache?.masterJobRecordValues && typeof cache.masterJobRecordValues === 'object') {
      Object.assign(incomingValues, cache.masterJobRecordValues);
    }

    if (Object.keys(incomingValues).length === 0) {
      return;
    }

    Object.entries(incomingValues).forEach(([fid, value]) => {
      const nextValue = value === null || value === undefined ? '' : String(value);
      this.job[String(fid)] = {
        ...(this.job[String(fid)] || {}),
        value: nextValue,
      };
    });
  }

  getCachedPhotoCount(): number {
    const cachedCount = Number(this.inspectionCache?.photoCount || this.inspectionCache?.photoBatchData?.rows?.length || 0);
    return Math.max(cachedCount, this.indexedDbInspectionPhotos.length);
  }

  getCachedInspectionPhotos(): CachedInspectionPhoto[] {
    const rows = this.inspectionCache?.photoBatchData?.rows;

    console.log('[EstimateInit] getCachedInspectionPhotos input:', {
      inspectionCacheRowCount: rows?.length || 0,
      indexedDbInspectionPhotosCount: this.indexedDbInspectionPhotos.length,
    });

    const fromCacheRows = Array.isArray(rows)
      ? rows
      .map((row: any) => {
        const base64 = String(row?.fid_8 || '').trim();
        if (!base64) {
          return null;
        }

        const dataUrl = this.toImageDataUrl(base64);
        if (!dataUrl || !dataUrl.startsWith('data:image/')) {
          return null;
        }

        return {
          id: this.generatePhotoId(dataUrl),
          src: dataUrl,
          section: this.toPhotoSectionLabel(String(row?.fid_6 || '')),
          notes: String(row?.fid_7 || '').trim(),
        } as CachedInspectionPhoto;
      })
      .filter((photo: CachedInspectionPhoto | null): photo is CachedInspectionPhoto => !!photo)
      : [];

    console.log('[EstimateInit] getCachedInspectionPhotos result:', {
      fromCacheRowsCount: fromCacheRows.length,
      fallbackToIndexedDb: fromCacheRows.length === 0,
      indexedDbInspectionPhotosCount: this.indexedDbInspectionPhotos.length,
    });

    if (fromCacheRows.length > 0) {
      return fromCacheRows;
    }

    return this.indexedDbInspectionPhotos;
  }

  openPhotoViewer(photo: CachedInspectionPhoto, index?: number) {
    const photos = this.cachedInspectionPhotos;
    const resolvedIndex = typeof index === 'number' ? index : photos.findIndex((row) => row.src === photo.src);
    this.selectedPhotoIndex = resolvedIndex >= 0 ? resolvedIndex : 0;
    this.selectedPhoto = photo;
    this.isPhotoViewerOpen = true;
  }

  isPhotoSelected(photoId: string): boolean {
    return this.selectedPhotoIds.has(photoId);
  }

  onSelectAllPhotosChange(event: any) {
    const isChecked = event.detail.checked;
    if (isChecked) {
      this.cachedInspectionPhotos.forEach(photo => {
        this.selectedPhotoIds.add(photo.id);
      });
    } else {
      this.selectedPhotoIds.clear();
    }
  }

  onPhotoSelectionChange(photoId: string, event: any) {
    const isChecked = event.detail.checked;
    if (isChecked) {
      this.selectedPhotoIds.add(photoId);
    } else {
      this.selectedPhotoIds.delete(photoId);
    }

    // Auto-update select all checkbox
    this.selectAllPhotos = this.selectedPhotoIds.size === this.cachedInspectionPhotos.length;
  }

  closePhotoViewer() {
    this.isPhotoViewerOpen = false;
    this.selectedPhoto = null;
    this.selectedPhotoIndex = -1;
    this.viewerTouchStartX = null;
  }

  showPreviousPhoto() {
    const photos = this.cachedInspectionPhotos;
    if (photos.length === 0 || this.selectedPhotoIndex < 0) {
      return;
    }

    this.selectedPhotoIndex = (this.selectedPhotoIndex - 1 + photos.length) % photos.length;
    this.selectedPhoto = photos[this.selectedPhotoIndex] || null;
  }

  showNextPhoto() {
    const photos = this.cachedInspectionPhotos;
    if (photos.length === 0 || this.selectedPhotoIndex < 0) {
      return;
    }

    this.selectedPhotoIndex = (this.selectedPhotoIndex + 1) % photos.length;
    this.selectedPhoto = photos[this.selectedPhotoIndex] || null;
  }

  onViewerTouchStart(event: TouchEvent) {
    this.viewerTouchStartX = event.touches?.[0]?.clientX ?? null;
  }

  onViewerTouchEnd(event: TouchEvent) {
    if (this.viewerTouchStartX === null) {
      return;
    }

    const endX = event.changedTouches?.[0]?.clientX ?? this.viewerTouchStartX;
    const deltaX = endX - this.viewerTouchStartX;
    this.viewerTouchStartX = null;

    if (Math.abs(deltaX) < 40) {
      return;
    }

    if (deltaX < 0) {
      this.showNextPhoto();
      return;
    }

    this.showPreviousPhoto();
  }

  private toImageDataUrl(base64: string): string {
    const normalized = String(base64 || '').trim();
    if (!normalized) {
      return '';
    }

    if (normalized.startsWith('data:image/')) {
      return normalized;
    }

    return `data:image/jpeg;base64,${normalized}`;
  }

  private toPhotoSectionLabel(sectionKey: string): string {
    const key = String(sectionKey || '').trim();
    if (!key) {
      return 'Inspection Photo';
    }

    return key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  getJobRecordId(job: any = this.job): string {
    return String(job?.['3']?.value || this.jobId || '').trim();
  }

  private async reconstructEstimateFromQuickBase() {
    console.log('[EstimateReconstruction] Starting reconstruction from QuickBase', { jobId: this.jobId });

    const response = await this.authService.retrieveEstimate(this.jobId);

    if (!response.success || !response.data) {
      console.warn('[EstimateReconstruction] Failed to retrieve estimate data', {
        success: response.success,
        message: response.message
      });
      return;
    }

    const { serviceOrder, lineItems, roofs, roofAssociations, photos } = response.data;

    // Reconstruct line items: catalog metadata + QuickBase transactional values
    if (Array.isArray(lineItems) && lineItems.length > 0) {
      this.activeEstimateItems = lineItems.map((item) => {
        const offeredServiceItemId = Number.parseInt(String(item.offeredServiceItemId), 10) || 0;
        const catalogItem = this.catalogItems.find((catalog) => catalog.id === offeredServiceItemId);

        const fallbackItem: EstimateCatalogItem = {
          id: offeredServiceItemId,
          name: String(item.description || '').trim(),
          description: String(item.description || '').trim(),
          category: '',
          serviceType: '',
          unit: 'ea',
          price: Number.isFinite(Number(item.price)) ? Number(item.price) : 0,
          isPackage: false,
          packageTier: '',
          sortOrder: 0,
        };

        const base = catalogItem || fallbackItem;

        return {
          ...base,
          qtyNeeded: item.qtyNeeded,
          lineSubtotal: item.lineSubtotal,
          sqFootage: item.sqFootage,
          price: Number.isFinite(Number(item.price)) ? Number(item.price) : base.price,
          specialInstructions: String(item.specialInstructions || '').trim() || undefined,
        };
      });
      console.log('[EstimateReconstruction] Reconstructed line items', { count: this.activeEstimateItems.length });
    }

    // Reconstruct roof selections
    if (Array.isArray(roofs) && Array.isArray(roofAssociations)) {
      const associatedRoofIds = new Set(
        roofAssociations.map(a => String(a.roofRecordId || '').trim())
      );

      this.inspectionHubRoofTiles = roofs.map(roof => ({
        id: String(roof.recordId || '').trim(),
        name: roof.name,
        material: roof.material,
        pitch: roof.pitch,
        squareFootage: roof.squareFootage,
        squareFootageLabel: String(roof.squareFootage),
        type: roof.type,
        status: roof.status,
        isAdded: associatedRoofIds.has(String(roof.recordId || '').trim())
      }));

      // Recalculate selected roof square footage
      this.selectedRoofSquareFootage = this.inspectionHubRoofTiles
        .filter(tile => tile.isAdded)
        .reduce((sum, tile) => sum + (tile.squareFootage || 0), 0);

      console.log('[EstimateReconstruction] Reconstructed roofs', {
        total: this.inspectionHubRoofTiles.length,
        selected: this.inspectionHubRoofTiles.filter(t => t.isAdded).length,
        totalSquareFootage: this.selectedRoofSquareFootage
      });
    }

    // Reconstruct photos
    if (Array.isArray(photos) && photos.length > 0) {
      this.cachedInspectionPhotos = photos
        .filter(photo => photo.dataUrl && photo.dataUrl.length > 0)
        .map((photo) => ({
          id: String(photo.recordId || ''),
          src: photo.dataUrl,
          section: photo.photoType || 'General',
          notes: ''
        }));
      console.log('[EstimateReconstruction] Reconstructed photos', { count: this.cachedInspectionPhotos.length });
      void this.persistEstimatePhotosToIndexedDbIfChanged();
    }

    // Restore service notes and scheduling dates
    if (serviceOrder) {
      this.serviceNotes = serviceOrder.serviceNotes || '';
      this.cleanMaintenanceScheduledFor = serviceOrder.cleanMaintenanceScheduledFor || this.getTodayDateInputValue();
      this.repairServicesScheduledFor = serviceOrder.repairServicesScheduledFor || this.getTodayDateInputValue();

      // Restore discount values
      this.secondaryDiscountAmount = serviceOrder.secondaryDiscountAmount || 0;

      // Restore location email
      if (serviceOrder.locationEmail) {
        this.locationEmail = serviceOrder.locationEmail;
      }

      // Restore customer record ID if available
      if (this.job && serviceOrder.customerFirstName) {
        this.job['93'] = { value: serviceOrder.customerFirstName };
      }
      if (this.job && serviceOrder.customerLastName) {
        this.job['94'] = { value: serviceOrder.customerLastName };
      }
      if (this.job && serviceOrder.customerPhone) {
        this.job['95'] = { value: serviceOrder.customerPhone };
      }

      console.log('[EstimateReconstruction] Restored service order fields', {
        hasServiceNotes: !!this.serviceNotes,
        hasMaintenanceDate: !!this.cleanMaintenanceScheduledFor,
        hasRepairDate: !!this.repairServicesScheduledFor,
        discountAmount: this.secondaryDiscountAmount
      });
    }

    // Recalculate pricing totals using existing logic
    this.syncPricingSummary();

    console.log('[EstimateReconstruction] Reconstruction complete, isEstimateRevision:', this.isEstimateRevision);
  }

  getFieldValue(fid: number, job: any = this.job): string {
    return String(job?.[String(fid)]?.value || '').trim();
  }

  getFieldDisplayValue(fid: number, job: any = this.job, booleanField = false): string {
    const value = this.getFieldValue(fid, job);
    if (!value) {
      return '';
    }

    if (booleanField) {
      const normalized = value.toLowerCase();
      if (['1', 'true', 'yes', 'checked'].includes(normalized)) {
        return 'Yes';
      }

      if (['0', 'false', 'no'].includes(normalized)) {
        return 'No';
      }
    }

    return value;
  }

  getSummaryFields(): EstimateFieldRow[] {
    return this.summaryFieldDefs
      .map((field) => ({
        label: field.label,
        value: this.getFieldDisplayValue(field.fid),
      }))
      .filter((field) => field.value);
  }

  getInspectionFields(): EstimateFieldRow[] {
    return this.inspectionFieldDefs
      .map((field) => ({
        label: field.label,
        value: this.getFieldDisplayValue(field.fid, this.job, !!field.boolean),
      }))
      .filter((field) => field.value);
  }

  getGroundInspectionFields(): EstimateFieldRow[] {
    return this.groundInspectionFieldDefs.map((field) => ({
      label: field.label,
      value: this.getGroundInspectionDisplayValue(field.fid),
    }));
  }

  getGroundInspectionDisplayValue(fid: number, job: any = this.job): string {
    const value = this.getFieldValue(fid, job);
    const normalized = value.toLowerCase();

    if (normalized === 'pass' || normalized === '1' || normalized === 'true' || normalized === 'yes') {
      return 'Pass';
    }

    if (normalized === 'fail' || normalized === '2' || normalized === 'false' || normalized === 'no') {
      return 'Fail';
    }

    return 'Untouched';
  }

  getCustomerName(job: any = this.job): string {
    const firstName = String(job?.['93']?.value || '').trim();
    const lastName = String(job?.['94']?.value || '').trim();
    return [firstName, lastName].filter(Boolean).join(' ') || 'Estimate';
  }

  getCustomerAddressLine(job: any = this.job): string {
    const streetNumber = String(job?.['106']?.value || '').trim();
    const streetName = String(job?.['107']?.value || '').trim();
    const city = String(job?.['92']?.value || '').trim();
    const state = String(job?.['105']?.value || '').trim();
    const streetLine = [streetNumber, streetName].filter(Boolean).join(' ');
    return [streetLine, city, state].filter(Boolean).join(', ');
  }

  goBack() {
    this.router.navigate(['/home']);
  }
}