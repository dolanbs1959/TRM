import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { trash } from 'ionicons/icons';
import { AuthService, OfferedServiceItem } from '../services/auth.service';
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

interface ActiveEstimateItem extends EstimateCatalogItem {
  qtyNeeded: number;
  lineSubtotal: number;
  sqFootage?: number;
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
export class EstimatePage implements OnInit {
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
  secondaryDiscountAmount = 0;
  secondaryDiscountPercentage = 0;
  isSubmittingEstimate = false;
  cleanMaintenanceScheduledFor = this.getTodayDateInputValue();
  repairServicesScheduledFor = this.getTodayDateInputValue();
  signatureDate = this.getTodayDateInputValue();
  discountMS = false;
  discountOther = false;
  msDiscountAmount = 0;
  otherDiscountAmount = 0;
  private signatureStrokeActive = false;
  private signatureHasInk = false;
  private viewerTouchStartX: number | null = null;
  private indexedDbInspectionPhotos: CachedInspectionPhoto[] = [];
  private msDiscountManuallyEdited = false;
  private static readonly INSPECTION_CACHE_PREFIX = 'trm.inspectionCache.';
  private static readonly INSPECTION_DRAFT_DB_NAME = 'trmInspectionDraftDb';
  private static readonly INSPECTION_DRAFT_DB_VERSION = 1;
  private static readonly INSPECTION_PHOTO_STORE_NAME = 'inspectionPhotoDrafts';
  private static readonly PACKAGE_SECTION_ORDER = ['Budget', 'Value', 'Basic Maintenance'];
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
    private alertController: AlertController
  ) {
    addIcons({ trash });
  }

  ngOnInit() {
    this.jobId = String(this.route.snapshot.paramMap.get('jobId') || '').trim();
    const navState = this.router.getCurrentNavigation()?.extras?.state as {
      job?: any;
      inspectionCache?: any;
    } | undefined;
    this.job = navState?.job || history.state?.job || null;

    if (!this.job && this.jobId) {
      this.job = { '3': { value: this.jobId } };
    }

    this.inspectionCache = navState?.inspectionCache || this.readInspectionCache(this.jobId);
    void this.initializeEstimateData();
  }

  ionViewDidEnter() {
    this.refreshSignatureCanvas();
  }

  private refreshSummaryViewModel() {
    this.summaryFields = this.getSummaryFields();
    this.inspectionFields = this.getInspectionFields();
    this.groundInspectionFields = this.getGroundInspectionFields();
  }

  private hasEstimateLookupFields(): boolean {
    return !!(this.getFieldValue(142) || this.getFieldValue(15));
  }

  private async initializeEstimateData() {
    if (this.jobId && !this.hasEstimateLookupFields()) {
      const detailedJob = await this.authService.getJobDetail(this.jobId);
      if (detailedJob) {
        this.job = detailedJob;
      }
    }

    this.applyInspectionCacheToJob(this.inspectionCache);
    this.hydrateSubmissionStateFromJob();
    this.refreshSummaryViewModel();
    this.hydrateRoofTilesFromCache();
    void this.loadInspectionPhotosFromIndexedDb();
    void this.loadOfferedServiceItems();
    void this.loadInspectionHubRoofs();
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

      this.indexedDbInspectionPhotos = this.buildCachedPhotosFromSerializedState(row?.inspectionPhotoState);
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
    if (!locationId) {
      const jobRecordId = this.getJobRecordId();
      if (jobRecordId) {
        const detailedJob = await this.authService.getJobDetail(jobRecordId);
        if (detailedJob) {
          this.job = detailedJob;
          this.applyInspectionCacheToJob(this.inspectionCache);
          this.refreshSummaryViewModel();
          locationId = this.getRelatedLocationId();
        }
      }
    }

    if (!locationId) {
      return;
    }

    this.roofsLoading = true;
    try {
      const roofs = await this.authService.getRoofsByLocation(locationId);
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

    const compactCache = {
      ...nextCache,
      photoBatchData: { tableId: 'bv3mp7tra', rows: [] },
      photoCount: Number(nextCache?.photoCount || 0),
    };

    const storageKey = this.getInspectionCacheStorageKey(serviceOrderId);

    this.inspectionCache = nextCache;
    try {
      localStorage.setItem(storageKey, JSON.stringify(nextCache));
      return;
    } catch (error) {
      if (!this.isStorageQuotaExceededError(error)) {
        console.warn('Failed to persist roofs into inspection cache.', error);
        return;
      }

      console.warn('Inspection cache exceeded localStorage quota while saving roofs. Retrying with compact payload.', {
        serviceOrderId,
      });
    }

    this.inspectionCache = compactCache;
    try {
      localStorage.setItem(storageKey, JSON.stringify(compactCache));
    } catch (error) {
      console.warn('Failed to persist compact roofs cache. Continuing without local cache update.', error);
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
    return this.activeEstimateItems.reduce((total, item) => total + item.qtyNeeded, 0);
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

  formatCurrency(value: number): string {
    const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `$${numericValue.toFixed(2)}`;
  }

  getCatalogItemCount(item: EstimateCatalogItem): number {
    const existing = this.activeEstimateItems.find((row) => row.id === item.id);
    return existing ? existing.qtyNeeded : 0;
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
        qtyNeeded: existing.qtyNeeded + 1,
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

  private getMSDiscountValue(): number {
    if (!this.discountMS) {
      return 0;
    }

    return Math.min(this.getCartSubtotal(), this.sanitizeCurrencyInput(this.msDiscountAmount));
  }

  private getOtherDiscountValue(): number {
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
    this.signatureHasInk = false;
    this.signatureStrokeActive = false;
    this.signatureDataUrl = '';
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
      description: String(item.description || item.name || '').trim(),
      unit: String(item.unit || '').trim(),
      qtyNeeded: Math.max(1, Number(item.qtyNeeded) || 1),
      sqFootage: Number(item.sqFootage || this.selectedRoofSquareFootage || 0) || 0,
      price: Number(item.price) || 0,
      lineSubtotal: Number(item.lineSubtotal) || 0,
      amount: Number(item.lineSubtotal) || 0,
      uom: String(item.unit || '').trim(),
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
      secondaryDiscountPercentage: this.secondaryDiscountPercentage,
      discountControlValue: this.discountControlValue,
      customerName,
      locationAddress,
      customerPhone,
      roofStructures,
      totalSquareFootage: this.selectedRoofSquareFootage,
      serviceNotes: this.serviceNotes || '',
      cleanMaintenanceScheduledFor: this.cleanMaintenanceScheduledFor || '',
      repairServicesScheduledFor: this.repairServicesScheduledFor || '',
    };
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
      const payload = this.buildEstimateSubmissionPayload(submissionMode, locationEmail);
      console.log('[Estimate Submit] Payload built:', payload);
      const response = await this.authService.submitEstimateSubmission(payload);
      console.log('[Estimate Submit] Response received:', response);
      if (!response?.success) {
        throw new Error(response?.message || 'Estimate submission failed');
      }

      this.clearSignaturePad();
      this.router.navigate(['/home']);
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

  private applyInspectionCacheToJob(cache: any) {
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
    const fromCacheRows = Array.isArray(rows)
      ? rows
      .map((row: any) => {
        const base64 = String(row?.fid_8 || '').trim();
        if (!base64) {
          return null;
        }

        return {
          src: this.toImageDataUrl(base64),
          section: this.toPhotoSectionLabel(String(row?.fid_6 || '')),
          notes: String(row?.fid_7 || '').trim(),
        } as CachedInspectionPhoto;
      })
      .filter((photo: CachedInspectionPhoto | null): photo is CachedInspectionPhoto => !!photo)
      : [];

    if (fromCacheRows.length > 0) {
      return fromCacheRows;
    }

    return this.indexedDbInspectionPhotos;
  }

  openPhotoViewer(photo: CachedInspectionPhoto, index?: number) {
    const photos = this.getCachedInspectionPhotos();
    const resolvedIndex = typeof index === 'number' ? index : photos.findIndex((row) => row.src === photo.src);
    this.selectedPhotoIndex = resolvedIndex >= 0 ? resolvedIndex : 0;
    this.selectedPhoto = photo;
    this.isPhotoViewerOpen = true;
  }

  closePhotoViewer() {
    this.isPhotoViewerOpen = false;
    this.selectedPhoto = null;
    this.selectedPhotoIndex = -1;
    this.viewerTouchStartX = null;
  }

  showPreviousPhoto() {
    const photos = this.getCachedInspectionPhotos();
    if (photos.length === 0 || this.selectedPhotoIndex < 0) {
      return;
    }

    this.selectedPhotoIndex = (this.selectedPhotoIndex - 1 + photos.length) % photos.length;
    this.selectedPhoto = photos[this.selectedPhotoIndex] || null;
  }

  showNextPhoto() {
    const photos = this.getCachedInspectionPhotos();
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