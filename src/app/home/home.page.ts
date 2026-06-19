import { Component, OnInit, OnDestroy, ViewChild, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { IonModal } from '@ionic/angular';
import { AlertController } from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { AuthService, WorkflowLogPayload } from '../services/auth.service';
import { LoadingService } from '../services/loading.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
  export class HomePage implements OnInit, OnDestroy {
    @ViewChild('dateModal') dateModal!: IonModal;
    private readonly jobActionStates = ['DISPATCH', 'ARRIVE', 'COMPLETE'] as const;

    private static readonly STORAGE_KEY = 'trm.homeState';
    private static readonly JOB_INDEX_STORAGE_KEY = 'trm.homeState.jobIndexes';
    private static readonly ACTIVE_JOB_ID_STORAGE_KEY = 'trm.activeJobId';
    private static readonly ACTIVE_JOB_MODE_STORAGE_KEY = 'trm.activeJobMode';
    private static readonly ACTIVE_JOB_PAUSED_STORAGE_KEY = 'trm.activeJobPaused';
    private static readonly INSPECTION_CACHE_PREFIX = 'trm.inspectionCache.';
    private static readonly INSPECTION_DRAFT_DB_NAME = 'trmInspectionDraftDb';
    private static readonly INSPECTION_DRAFT_DB_VERSION = 1;
    private static readonly INSPECTION_PHOTO_STORE_NAME = 'inspectionPhotoDrafts';
    private static readonly ESTIMATE_DRAFT_STORAGE_KEY_PREFIX = 'trm_estimate_draft_';

    tech: any = {
      id: '',
      firstName: '',
      lastName: '',
      phone: '',
      role: ''
   };
  serviceOrders: any[] | null = null;
  isLoadingSchedule = true;
   today: Date = new Date();
   selectedDateIso: string = new Date().toISOString();
   hoursWorked: string = '0'; 
   ptoAvailable: string = '0';
   weather: any;
   cityQuery: string = '';
   citySuggestions: any[] = [];
   showCitySuggestions: boolean = false;
   isLoadingWeather: boolean = false;
  isClockedIn: boolean = false;
  isClockActionLoading: boolean = false;
  activeTimecardRecordId: string | null = null;
  clockInStartedAtMs: number | null = null;
  clockedInAtText: string = 'Not clocked in';
  timeOnClockText: string = 'Time on Clock: 0h 0m';
  private clockTimerId: number | null = null;
  private readonly geolocationTargetAccuracyMeters = 30;
  private readonly geolocationSampleWindowMs = 5000;
  private readonly geolocationHardTimeoutMs = 10000;
  selectedJobRecordId: string | null = null;
  workflowLockedJobRecordId: string | null = null;
  isJobPauseActionLoading: boolean = false;
   private citySearchDebounce: any;
   apiKey: string = '1aeba395c05d88a9369eb7127f21afca';
  private viewEnterCount = 0;
  private draftStateCache: Record<string, boolean> = {};

  constructor(
    private authService: AuthService,
    private router: Router,
    private alertController: AlertController,
    private changeDetectorRef: ChangeDetectorRef,
    private loadingService: LoadingService
  ) {}

  async getLocalWeather() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          await this.fetchWeatherByCoords(pos.coords.latitude, pos.coords.longitude);
        },
        async () => {
          console.warn('GPS unavailable, falling back to Puyallup');
          await this.fetchWeatherByCity('Puyallup');
        }
      );
    } else {
      await this.fetchWeatherByCity('Puyallup');
    }
  }

  async fetchWeatherByCoords(lat: number, lon: number) {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${this.apiKey}&units=imperial`;
    await this.loadWeatherFromUrl(url);
  }

  async fetchWeatherByCity(city: string) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${this.apiKey}&units=imperial`;
    await this.loadWeatherFromUrl(url);
  }

  async loadWeatherFromUrl(url: string) {
    try {
      this.isLoadingWeather = true;
      const response = await fetch(url);
      const data = await response.json();
      console.log('Weather API Response:', data);
      if (data.main) {
        this.weather = {
          temp: Math.round(data.main.temp),
          feelsLike: Math.round(data.main.feels_like),
          humidity: data.main.humidity,
          wind: Math.round(data.wind.speed),
          icon: data.weather[0].icon,
          description: data.weather[0].description,
          city: data.name,
          country: data.sys.country
        };
        this.cityQuery = `${data.name}, ${data.sys.country}`;
      } else {
        console.error('Weather error:', data.message);
      }
    } catch (error) {
      console.error('Weather fetch failed', error);
    } finally {
      this.isLoadingWeather = false;
    }
  }

  onCityQueryChange(value: string | null | undefined) {
    const query = value || '';
    this.cityQuery = query;
    if (this.citySearchDebounce) clearTimeout(this.citySearchDebounce);
    if (query.length < 2) {
      this.citySuggestions = [];
      this.showCitySuggestions = false;
      return;
    }
    this.citySearchDebounce = setTimeout(() => this.fetchCitySuggestions(query), 400);
  }

  async fetchCitySuggestions(query: string) {
    const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=5&appid=${this.apiKey}`;
    try {
      const res = await fetch(url);
      const suggestions = await res.json();
      this.citySuggestions = Array.isArray(suggestions) ? suggestions : [];
      this.showCitySuggestions = this.citySuggestions.length > 0;
    } catch (e) {
      console.error('City suggestion fetch failed', e);
    }
  }

  selectCitySuggestion(suggestion: any) {
    this.showCitySuggestions = false;
    this.citySuggestions = [];
    this.fetchWeatherByCoords(suggestion.lat, suggestion.lon);
  }

  onCityInputBlur() {
    setTimeout(() => { this.showCitySuggestions = false; }, 250);
  }

  useGpsWeather() {
    this.cityQuery = '';
    this.showCitySuggestions = false;
    this.getLocalWeather();
  }

  async onDateChange(dateValue: string | string[] | null | undefined) {
    if (!dateValue) return;
    const iso = Array.isArray(dateValue) ? dateValue[0] : dateValue;
    if (!iso) return;
    
    // Parse as local date to avoid timezone offset issues
    const parts = iso.split('T')[0].split('-');
    const localDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    this.today = localDate;
    this.selectedDateIso = iso;
    
    await this.dateModal.dismiss();
    await this.fetchScheduleForDate(localDate);
  }

  async fetchScheduleForDate(date: Date) {
    if (!this.tech.id) return;
    this.isLoadingSchedule = true;
    this.serviceOrders = null;
    this.selectedJobRecordId = null;
    this.workflowLockedJobRecordId = null;

    // Format date as YYYY-MM-DD using local date, not UTC
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()) .padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const res = await firstValueFrom(this.authService.getSchedule(Number(this.tech.id), dateStr));
    console.log('--- FRONTEND RAW SCHEDULE DATA PULL ---', res);
    console.log('--- FRONTEND SCHEDULE ASSIGNMENT RECON ---', {
      selectedDate: dateStr,
      techId: this.tech.id,
      role: this.tech.role,
      responseType: typeof res,
      isArray: Array.isArray(res),
      length: Array.isArray(res) ? res.length : null,
      topLevelKeys: res && typeof res === 'object' && !Array.isArray(res) ? Object.keys(res) : []
    });
    if (Array.isArray(res) && res.length > 0) {
      // console.log('--- FRONTEND FIRST RAW SCHEDULE RECORD ---', JSON.stringify(res[0], null, 2));
      console.log('--- FRONTEND SCHEDULE CONTACT SNAPSHOT ---', {
        selectedDate: dateStr,
        totalRecords: res.length,
        sample: res.slice(0, 10).map((record) => ({
          recordId: this.getJobRecordId(record),
          phone: this.getPhoneNumber(record),
          mobile: this.getMobilePhone(record),
          email: this.getEmailAddress(record)
        })),
        missingEmailCount: res.filter((record) => !this.getEmailAddress(record)).length
      });
    }

    this.serviceOrders = Array.isArray(res)
      ? res.map((record) => {
          // console.log('Evaluating Card Display:', {
          //   id: record?.id ?? record?.['3']?.value ?? null,
          //   stage: record?.stage ?? record?.['40']?.value ?? null,
          //   status: record?.status ?? record?.['11']?.value ?? null
          // });
          return { ...record, _jobActionIndex: this.computeJobActionIndexFromStatus(record) };
        })
      : [];
    this.restoreJobActionIndexes();
    this.restoreUiState();
    console.log('Schedule for', dateStr, ':', this.serviceOrders.length, 'jobs');
    this.isLoadingSchedule = false;
  }

  getClockButtonLabel() {
    if (this.isClockActionLoading) {
      return this.isClockedIn ? 'CLOCKING OUT...' : 'CLOCKING IN...';
    }

    return this.isClockedIn ? 'CLOCK OUT' : 'CLOCK IN';
  }

  async toggleClockState() {
    if (this.isClockActionLoading) {
      return;
    }

    this.isClockActionLoading = true;

    try {
      if (!this.isClockedIn) {
        console.time('Clock In - Geolocation');
        const clockInCoordinates = await this.getCurrentCoordinates();
        console.timeEnd('Clock In - Geolocation');
        console.time('Clock In - API Call');
        const recordId = await this.authService.clockInTimecard(this.tech.id, clockInCoordinates);
        console.timeEnd('Clock In - API Call');
        if (!recordId) {
          console.error('Clock in failed: no timecard record ID returned.');
          return;
        }

        this.activeTimecardRecordId = recordId;
        this.isClockedIn = true;
        this.clockInStartedAtMs = Date.now();
        this.startClockTimer();
        this.saveUiState();
        return;
      }

      if (!this.activeTimecardRecordId) {
        console.error('Clock out blocked: missing active timecard record ID.');
        return;
      }

      console.time('Clock Out - Geolocation');
      const clockOutCoordinates = await this.getCurrentCoordinates();
      console.timeEnd('Clock Out - Geolocation');
      console.time('Clock Out - API Call');
      const didClockOut = await this.authService.clockOutTimecard(
        this.activeTimecardRecordId,
        clockOutCoordinates
      );
      console.timeEnd('Clock Out - API Call');

      if (!didClockOut) {
        console.error('Clock out failed: timecard update did not succeed.');
        return;
      }

      this.isClockedIn = false;
      this.activeTimecardRecordId = null;
      this.clockInStartedAtMs = null;
      this.stopClockTimer();
      this.updateClockDashboardDisplay();
      this.selectedJobRecordId = null;
      this.workflowLockedJobRecordId = null;
      this.jobTapTimestamps = [];
      this.saveUiState();
      this.saveJobActionIndexes();
    } catch (error) {
      console.error('Clock action failed:', error);
    } finally {
      this.isClockActionLoading = false;
    }
  }

  private jobTapTimestamps: number[] = [];
  isJobComplete(job: any): boolean {
    const status = (job?.['11']?.value || '').toString().trim().toLowerCase();
    return status === 'inspected'
      || status === 'invoiced'
      || status === 'complete'
      || status === 'inspection complete'
      || status === 'estimated'
      || status === 'sold';
  }

  private isInspectedJob(job: any): boolean {
    const status = (job?.['11']?.value || '').toString().trim().toLowerCase();
    return status === 'inspected';
  }

  private isInspectionJob(job: any): boolean {
    return (job?.['40']?.value || '').toString().trim().toLowerCase() === 'inspection';
  }

  selectJob(job: any) {
    if (!this.isClockedIn) {
      return;
    }

    if (this.isJobComplete(job)) {
      return;
    }

    const jobRecordId = this.getJobRecordId(job);
    if (!jobRecordId) {
      return;
    }

    // Ensure the job's action index reflects its current status (do not lower saved progress)
    try {
      const jobObj = this.serviceOrders?.find((j) => this.getJobRecordId(j) === jobRecordId);
      if (jobObj) {
        const derived = this.computeJobActionIndexFromStatus(jobObj);
        if ((jobObj._jobActionIndex || 0) < derived) {
          jobObj._jobActionIndex = derived;
          this.saveJobActionIndexes();
          this.saveUiState();
        }
      }
    } catch (e) {
      // non-fatal
    }

    // Triple-tap unlock logic
    if (this.workflowLockedJobRecordId && this.workflowLockedJobRecordId === jobRecordId) {
      this.jobTapTimestamps.push(Date.now());
      // Only keep last 3 taps
      if (this.jobTapTimestamps.length > 3) this.jobTapTimestamps.shift();
      // If 3 taps within 1.5 seconds, unlock
      if (
        this.jobTapTimestamps.length === 3 &&
        this.jobTapTimestamps[2] - this.jobTapTimestamps[0] < 1500
      ) {
        // Reset workflow state for this job
        const unlockedJob = this.serviceOrders?.find(j => this.getJobRecordId(j) === jobRecordId);
        if (unlockedJob) unlockedJob._jobActionIndex = 0;
        this.selectedJobRecordId = null;
        this.workflowLockedJobRecordId = null;
        this.jobTapTimestamps = [];
        this.saveUiState();
        this.saveJobActionIndexes();
        return;
      }
      // Otherwise, ignore tap
      return;
    } else {
      this.jobTapTimestamps = [];
    }

    if (this.workflowLockedJobRecordId && this.workflowLockedJobRecordId !== jobRecordId) {
      return;
    }

    // Toggle selection: if already selected, unselect it
    if (this.selectedJobRecordId === jobRecordId) {
      this.selectedJobRecordId = null;
      this.saveUiState();
      return;
    }

    // Select the new job (single selection model)
    this.selectedJobRecordId = jobRecordId;
    this.saveUiState();
  }

  isSelectedJob(job: any) {
    return this.getJobRecordId(job) === this.selectedJobRecordId;
  }

  getSelectedJobActionLabel() {
    const selectedJob = this.getSelectedJob();
    if (!selectedJob) {
      return 'SELECT JOB';
    }

    return this.jobActionStates[selectedJob._jobActionIndex || 0];
  }

  getSelectedJobActionColor() {
    const selectedJob = this.getSelectedJob();
    if (!selectedJob) {
      return 'medium';
    }

    const currentIndex = selectedJob._jobActionIndex || 0;
    if (currentIndex === 0) return 'warning';
    if (currentIndex === 1) return 'primary';
    return 'success';
  }

  shouldShowJobSecondaryActions() {
    const selectedJob = this.getSelectedJob();
    if (!selectedJob || !this.selectedJobRecordId) {
      return false;
    }

    const isVisible = (selectedJob._jobActionIndex || 0) === 2;
    // console.log('[UI][SecondaryActions][VisibilityCheck]', {
    //   selectedJobId: this.selectedJobRecordId,
    //   workflowLockedJobRecordId: this.workflowLockedJobRecordId,
    //   actionIndex: selectedJob._jobActionIndex,
    //   isPaused: !!selectedJob._isPaused,
    //   visible: isVisible
    // });

    return isVisible;
  }

  getPauseResumeButtonLabel() {
    const selectedJob = this.getSelectedJob();
    return selectedJob?._isPaused ? 'RESUME JOB' : 'PAUSE JOB';
  }

  getJobStatusLabel(job: any) {
    if (this.workflowLockedJobRecordId === this.getJobRecordId(job)) {
      const currentIndex = job?._jobActionIndex || 0;
      if (currentIndex === 1) {
        return 'En Route';
      }
      if (currentIndex === 2) {
        return 'In Progress';
      }
    }

    return job?.['11']?.value || 'Scheduled';
  }

  getJobStatusColor(job: any) {
    if (this.workflowLockedJobRecordId === this.getJobRecordId(job)) {
      const currentIndex = job?._jobActionIndex || 0;
      if (currentIndex === 1) {
        return 'warning';
      }
      if (currentIndex === 2) {
        return 'primary';
      }
    }

    return 'primary';
  }

  isWorkflowActionDisabled() {
    const selectedJob = this.getSelectedJob();
    return !this.isClockedIn || !this.selectedJobRecordId || !!selectedJob?._isPaused;
  }

  isJobPaused() {
    return !!this.getSelectedJob()?._isPaused;
  }

  async advanceSelectedJobAction() {
    const selectedJob = this.getSelectedJob();
    if (!selectedJob) {
      return;
    }

    const selectedJobType = (
      selectedJob?.type ||
      selectedJob?.jobType ||
      selectedJob?.['40']?.value ||
      ''
    )
      .toString()
      .trim()
      .toLowerCase();
    const isInspectionSelected = selectedJobType === 'inspection';
    const selectedRecordId = this.getJobRecordId(selectedJob) || (this.selectedJobRecordId || '').toString();

    const currentIndex = selectedJob._jobActionIndex || 0;
    if (currentIndex === 0) {
      await this.loadingService.withLoading(
        'Dispatching...',
        async () => {
          const didUpdate = await this.updateSelectedJobStatus('En Route', 'Dispatch');
          if (!didUpdate) {
            return;
          }
          this.workflowLockedJobRecordId = this.selectedJobRecordId;
        }
      );
      // return;
    }

    if (currentIndex === 1) {
      await this.loadingService.withLoading(
        'Recording Arrival...',
        async () => {
          if (this.isInspectionJob(selectedJob)) {
            try {
              await this.authService.getRoofOptionCache();
            } catch (error) {
              console.warn('Roof option cache preload failed on ARRIVE:', error);
            }
          }

          const didUpdate = await this.updateSelectedJobStatus('In Progress', 'Arrival');
          if (!didUpdate) {
            return;
          }
          selectedJob._isPaused = false;
        }
      );
      // return;
    }

    if (currentIndex < this.jobActionStates.length - 1) {
      selectedJob._jobActionIndex = currentIndex + 1;
      this.saveJobActionIndexes();
      this.saveUiState();

      if (currentIndex === 1 && this.selectedJobRecordId) {
        this.openJobDetail(this.selectedJobRecordId, 'work');
      }

      return;
    }

    if (isInspectionSelected) {
      const didCompleteInspection = await this.completeInspectionFromDraft(selectedRecordId);
      if (!didCompleteInspection) {
        return;
      }

      selectedJob._jobActionIndex = 0;
      selectedJob._isPaused = false;
      this.workflowLockedJobRecordId = null;
      this.selectedJobRecordId = null;
      this.saveJobActionIndexes();
      this.saveUiState();
      await this.fetchScheduleForDate(this.today);
      return;
    }

    const completionStatus = 'Invoiced';
    const didComplete = await this.updateSelectedJobStatus(completionStatus, 'Complete');
    if (!didComplete) {
      return;
    }

    if (completionStatus === 'Invoiced' && this.activeTimecardRecordId) {
      try {
        const didRecordEvent = await this.authService.recordTimecardJobEvent(
          this.activeTimecardRecordId,
          'complete'
        );
        if (!didRecordEvent) {
          console.warn('Timecard COMPLETE timestamp was not recorded.');
        }
      } catch (error) {
        console.warn('Failed to record COMPLETE timestamp on timecard:', error);
      }
    }

    selectedJob._jobActionIndex = 0;
    selectedJob._isPaused = false;
    this.workflowLockedJobRecordId = null;
    this.selectedJobRecordId = null;
    this.saveJobActionIndexes();
    this.saveUiState();
    await this.fetchScheduleForDate(this.today);
  }

  private async completeInspectionFromDraft(serviceOrderId: string): Promise<boolean> {
    console.log('CRITICAL GATED CHECKPOINT: INSPECTION CONVEYOR BELT ROUTE ENGAGED');

    const normalizedServiceOrderId = (serviceOrderId || '').toString().trim();
    if (!normalizedServiceOrderId) {
      console.error('Inspection completion blocked: missing service order id.');
      return false;
    }

    if (this.selectedJobRecordId !== normalizedServiceOrderId) {
      this.selectedJobRecordId = normalizedServiceOrderId;
    }

    const draftStorageKey = `trm_inspection_draft_${normalizedServiceOrderId}`;
    const rawDraft = localStorage.getItem(draftStorageKey);
    if (!rawDraft) {
      console.error('Inspection completion blocked: no local inspection draft found.', {
        serviceOrderId: normalizedServiceOrderId,
        draftStorageKey,
      });
      return false;
    }

    try {
      // STEP A: Parse and transform the local draft into backend submission payload.
      const draftPayload = JSON.parse(rawDraft);
      const indexedDbPhotoState = await this.readInspectionPhotosFromIndexedDb(normalizedServiceOrderId);
      if (indexedDbPhotoState && typeof indexedDbPhotoState === 'object') {
        draftPayload.inspectionPhotoState = indexedDbPhotoState;
      }

      const submissionPayload = this.buildInspectionSubmissionPayloadFromDraft(
        draftPayload,
        normalizedServiceOrderId
      );

      // Attach workflow log metadata so submit-inspection-data can create a Workflow Logs record
      // (this mirrors DISPATCH/ARRIVED behavior and guarantees parent SO is passed).
      try {
        const workflowLog = await this.buildWorkflowLogPayload('Complete', 'Status set to Inspected after submit-inspection-data success.');
        if (workflowLog) {
          const sp: any = submissionPayload as any;
          sp.workflowEventType = workflowLog.eventType;
          sp.workflowEventTimestamp = workflowLog.eventTimestamp;
          sp.workflowGpsCoordinates = workflowLog.gpsCoordinates;
          sp.workflowNotes = workflowLog.notes || '';
          sp.relatedEmployeeId = workflowLog.relatedEmployeeId;
        }
      } catch (e) {
        // Non-fatal: continue without workflow metadata if building it fails.
        console.warn('Failed to attach workflow metadata to inspection submission:', e);
      }

      // STEP B: Explicitly write workflow record and advance status to Inspected FIRST
      const didAdvanceStatus = await this.updateSelectedJobStatus('Inspected');
      if (!didAdvanceStatus) {
        console.error('Inspection completion blocked: status update to Inspected failed.');
        return false;
      }

      // STEP C: Execute the heavy data/photo submission request downstream.
      const didSubmitDraft = await this.authService.submitInspectionData(submissionPayload);
      if (!didSubmitDraft) {
        console.error('Inspection completion blocked: submit-inspection-data request failed.');
        return false;
      }

      this.persistInspectionCache(normalizedServiceOrderId, submissionPayload);
      this.applyInspectionValuesToJob(normalizedServiceOrderId, submissionPayload.masterJobRecordValues);
      localStorage.removeItem(draftStorageKey);
      return true;
    } catch (error) {
      console.error('INSPECTION EXECUTOR CRASHED:', error);
      return false;
    }
  }

  private buildInspectionSubmissionPayloadFromDraft(draft: any, serviceOrderId: string) {
    const inspectionForm = draft?.inspectionForm || {};
    const groundInspectionItems = Array.isArray(draft?.groundInspectionItems)
      ? draft.groundInspectionItems
      : [];
    const inspectionPhotoState = draft?.inspectionPhotoState || {};

    const toOptionalNumber = (value: any): number | null => {
      const normalized = (value || '').toString().trim();
      if (!normalized) {
        return null;
      }

      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const toGroundChoiceValue = (state: number): string => {
      if (state === 1) {
        return 'Pass';
      }

      if (state === 2) {
        return 'Fail';
      }

      return '';
    };

    const toQuickbaseCheckboxValue = (value: any): boolean => {
      if (typeof value === 'boolean') {
        return value;
      }

      if (typeof value === 'number') {
        return value === 1;
      }

      const normalized = (value || '').toString().trim().toLowerCase();
      if (!normalized) {
        return false;
      }

      return (
        normalized === 'true' ||
        normalized === '1' ||
        normalized === 'yes' ||
        normalized === 'checked' ||
        normalized === 'on'
      );
    };

    const normalizeBase64Value = (value: string): string => {
      const normalized = (value || '').toString().trim().replace(/^['"]|['"]$/g, '');
      if (!normalized || normalized === '[object Object]') {
        return '';
      }

      if (normalized.startsWith('blob:')) {
        return '';
      }

      const dataUrlMatch = normalized.match(/^data:[^;]+;base64,(.*)$/i);
      if (dataUrlMatch && typeof dataUrlMatch[1] === 'string') {
        return dataUrlMatch[1].replace(/\s+/g, '');
      }

      const commaIndex = normalized.indexOf(',');
      if (commaIndex !== -1 && normalized.slice(0, commaIndex).includes('base64')) {
        return normalized.slice(commaIndex + 1).replace(/\s+/g, '');
      }

      return normalized.replace(/\s+/g, '');
    };

    const toBase64FromByteArray = (bytes: number[]): string => {
      if (!Array.isArray(bytes) || bytes.length === 0) {
        return '';
      }

      try {
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.slice(i, i + chunkSize).map((item) => Number(item) & 0xff);
          binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
      } catch {
        return '';
      }
    };

    const extractBase64FromPhoto = (photo: any): string => {
      const candidates: any[] = [
        photo,
        photo?.dataUrl,
        photo?.base64,
        photo?.base64Data,
        photo?.imageBase64,
        photo?.photoBase64,
        photo?.fid_8,
        photo?.blob,
        photo?.blob?.data,
        photo?.buffer,
        photo?.buffer?.data,
        photo?.file,
        photo?.file?.data,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
          if (candidate.length === 0) {
            continue;
          }

          const isNumericArray = candidate.every((item) => Number.isFinite(Number(item)));
          if (isNumericArray) {
            const fromNumericArray = toBase64FromByteArray(candidate as number[]);
            if (fromNumericArray) {
              return fromNumericArray;
            }
          }

          for (const nestedCandidate of candidate) {
            if (typeof nestedCandidate === 'string') {
              const fromNestedString = normalizeBase64Value(nestedCandidate);
              if (fromNestedString) {
                return fromNestedString;
              }
            }

            if (nestedCandidate && typeof nestedCandidate === 'object') {
              const nestedObjectValues = [
                nestedCandidate?.dataUrl,
                nestedCandidate?.base64,
                nestedCandidate?.base64Data,
                nestedCandidate?.imageBase64,
                nestedCandidate?.photoBase64,
              ];

              for (const nestedObjectValue of nestedObjectValues) {
                if (typeof nestedObjectValue !== 'string') {
                  continue;
                }

                const fromNestedObject = normalizeBase64Value(nestedObjectValue);
                if (fromNestedObject) {
                  return fromNestedObject;
                }
              }
            }
          }
        }

        if (typeof candidate === 'string') {
          const fromString = normalizeBase64Value(candidate);
          if (fromString) {
            return fromString;
          }
          continue;
        }

        if (!candidate || typeof candidate !== 'object') {
          continue;
        }

        if (Array.isArray(candidate?.data)) {
          const fromBytes = toBase64FromByteArray(candidate.data);
          if (fromBytes) {
            return fromBytes;
          }
        }

        if (candidate?.type === 'Buffer' && Array.isArray(candidate?.data)) {
          const fromNodeBuffer = toBase64FromByteArray(candidate.data);
          if (fromNodeBuffer) {
            return fromNodeBuffer;
          }
        }

        const nestedStringCandidates = [
          candidate?.dataUrl,
          candidate?.base64,
          candidate?.base64Data,
          candidate?.imageBase64,
          candidate?.photoBase64,
        ];
        for (const nestedValue of nestedStringCandidates) {
          if (typeof nestedValue !== 'string') {
            continue;
          }

          const fromNested = normalizeBase64Value(nestedValue);
          if (fromNested) {
            return fromNested;
          }
        }
      }

      return '';
    };

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
      '48': (inspectionForm.penetrationsLeaks || '').toString(),
      '49': (inspectionForm.fieldCondition || '').toString(),
      '50': (inspectionForm.ridgeCondition || '').toString(),
      '153': Array.isArray(inspectionForm.flashingsNeedingService) ? inspectionForm.flashingsNeedingService.join(';') : (inspectionForm.flashingsNeedingService || '').toString(),
      '51': toQuickbaseCheckboxValue(inspectionForm.bootsNeeded),
      '52': toOptionalNumber(inspectionForm.bootQty15),
      '56': toOptionalNumber(inspectionForm.bootQty2),
      '57': toOptionalNumber(inspectionForm.bootQty3),
      '55': toQuickbaseCheckboxValue(inspectionForm.ventsNeeded),
      '53': toOptionalNumber(inspectionForm.af50VentQty),
      '59': toOptionalNumber(inspectionForm.bf4VentQty),
      '58': toOptionalNumber(inspectionForm.bf6VentQty),
      '10': (inspectionForm.inspectionNotes || '').toString(),
    };

    for (const item of groundInspectionItems) {
      const targetFid = groundFieldMap[Number(item?.id)];
      if (!targetFid) {
        continue;
      }

      masterJobRecordValues[targetFid] = toGroundChoiceValue(Number(item?.state));
    }

    const photoRows: Array<{ fid_6: string; fid_7: string; fid_8: string; fid_9: string }> = [];
    const sectionKeys = [
      'penetrations',
      'fieldCondition',
      'ridgeCondition',
      'flashing',
      'boot',
      'vents',
      'ground',
    ];

    for (const sectionKey of sectionKeys) {
      const sectionPhotos = Array.isArray(inspectionPhotoState?.[sectionKey])
        ? inspectionPhotoState[sectionKey]
        : [];

      for (const photo of sectionPhotos) {
        const section = sectionKey;
        const notes = (photo?.notes || '').toString().trim();
        const base64Str = extractBase64FromPhoto(photo);
        console.log(
          'MAPPED PHOTO ROW:',
          section,
          notes ? notes : 'No notes',
          base64Str ? 'Base64 Valid' : 'Base64 EMPTY'
        );

        photoRows.push({
          fid_6: section,
          fid_7: notes,
          fid_8: base64Str,
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

  async toggleJobPauseResume() {
    if (this.isJobPauseActionLoading || !this.shouldShowJobSecondaryActions()) {
      return;
    }

    const selectedJob = this.getSelectedJob();
    const selectedRecordId = this.selectedJobRecordId;
    if (!selectedJob || !selectedRecordId) {
      return;
    }

    this.isJobPauseActionLoading = true;
    try {
      if (selectedJob._isPaused) {
        const resumeNote = this.buildNoteEntry('Job resumed');
        const resumeWorkflowLog = await this.buildWorkflowLogPayload('Resume', 'Job resumed');
        const didAppendResume = await this.authService.appendServiceOrderNote(
          selectedRecordId,
          resumeNote,
          resumeWorkflowLog
        );
        if (!didAppendResume) {
          console.error('Failed to append resume note.');
          return;
        }
        selectedJob._isPaused = false;
        this.saveJobActionIndexes();
        return;
      }

      const reason = await this.promptPauseReason();
      if (!reason) {
        return;
      }

      const pauseNote = this.buildNoteEntry(`Pause reason: ${reason}`);
      const pauseWorkflowLog = await this.buildWorkflowLogPayload('Pause', `Pause reason: ${reason}`);
      const didAppendPause = await this.authService.appendServiceOrderNote(
        selectedRecordId,
        pauseNote,
        pauseWorkflowLog
      );
      if (!didAppendPause) {
        console.error('Failed to append pause reason.');
        return;
      }

      selectedJob._isPaused = true;
      this.saveJobActionIndexes();
    } catch (error) {
      console.error('Pause/resume action failed:', error);
    } finally {
      this.isJobPauseActionLoading = false;
    }
  }

  async markReturnRequired() {
    if (!this.shouldShowJobSecondaryActions()) {
      return;
    }

    const selectedJob = this.getSelectedJob();
    if (!selectedJob) {
      return;
    }

    await this.loadingService.withLoading(
      'Updating Job Status...',
      async () => {
        const didUpdate = await this.updateSelectedJobStatus('Return Required', 'Return Required');
        if (!didUpdate) {
          return;
        }

        if (this.activeTimecardRecordId) {
          try {
            const didRecordEvent = await this.authService.recordTimecardJobEvent(
              this.activeTimecardRecordId,
              'return_required'
            );
            if (!didRecordEvent) {
              console.warn('Timecard RETURN REQUIRED timestamp was not recorded.');
            }
          } catch (error) {
            console.warn('Failed to record RETURN REQUIRED timestamp on timecard:', error);
          }
        }

        selectedJob._jobActionIndex = 0;
        selectedJob._isPaused = false;
        this.workflowLockedJobRecordId = null;
        this.selectedJobRecordId = null;
        this.saveJobActionIndexes();
        this.saveUiState();
        await this.fetchScheduleForDate(this.today);
      }
    );
  }

  private async updateSelectedJobStatus(nextStatus: string, workflowEventType?: string): Promise<boolean> {
    const selectedJob = this.getSelectedJob();
    const selectedRecordId = this.selectedJobRecordId;
    if (!selectedJob || !selectedRecordId) {
      return false;
    }

    try {
      const workflowLog = workflowEventType
        ? await this.buildWorkflowLogPayload(workflowEventType, `Status set to ${nextStatus}`)
        : undefined;

      const didUpdate = await this.authService.updateServiceOrderStatus(
        selectedRecordId,
        nextStatus,
        workflowLog
      );
      if (!didUpdate) {
        console.error(`Failed to update job status to ${nextStatus}.`);
        return false;
      }

      selectedJob['11'] = { value: nextStatus };
      return true;
    } catch (error) {
      console.error(`Status update failed for ${nextStatus}:`, error);
      return false;
    }
  }

  private async buildWorkflowLogPayload(eventType: string, notes = ''): Promise<WorkflowLogPayload> {
    const relatedEmployeeId = Number.parseInt(String(this.tech?.id || ''), 10);
    if (!Number.isFinite(relatedEmployeeId)) {
      throw new Error('Unable to build workflow log: employee id must be numeric.');
    }

    let gpsCoordinates = 'Unavailable';
    try {
      gpsCoordinates = await this.getCurrentCoordinates();
    } catch (error) {
      console.warn('Workflow log geolocation capture failed:', error);
    }

    return {
      eventType,
      eventTimestamp: new Date().toISOString(),
      gpsCoordinates,
      notes,
      relatedEmployeeId,
    };
  }

  private buildNoteEntry(text: string): string {
    const now = new Date();
    const datePart = now.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
    const timePart = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const name = `${this.tech.firstName || ''} ${this.tech.lastName || ''}`.trim();
    return `[${name} - ${datePart} ${timePart}] ${text}<br>`;
  }

  private async promptPauseReason(): Promise<string | null> {
    let selectedReason: string | null = null;

    const reasonAlert = await this.alertController.create({
      header: 'Pause Job',
      message: 'Select a reason:',
      inputs: [
        { type: 'radio', label: 'Material Run', value: 'Material Run', checked: true },
        { type: 'radio', label: 'Equipment Issue', value: 'Equipment Issue' },
        { type: 'radio', label: 'Weather Delay', value: 'Weather Delay' },
        { type: 'radio', label: 'Other', value: 'Other' },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Continue',
          handler: (value: string) => {
            selectedReason = value;
          },
        },
      ],
    });

    await reasonAlert.present();
    const { role } = await reasonAlert.onDidDismiss();
    if (role === 'cancel' || !selectedReason) {
      return null;
    }

    if (selectedReason !== 'Other') {
      return selectedReason;
    }

    let otherText = '';
    const otherAlert = await this.alertController.create({
      header: 'Pause Job',
      message: 'Enter the reason:',
      inputs: [
        {
          name: 'otherReason',
          type: 'textarea',
          placeholder: 'Type pause reason',
        },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Save',
          handler: (value: { otherReason?: string }) => {
            otherText = (value?.otherReason || '').trim();
          },
        },
      ],
    });

    await otherAlert.present();
    const dismissResult = await otherAlert.onDidDismiss();
    if (dismissResult.role === 'cancel') {
      return null;
    }

    return otherText || 'Other';
  }

  // --- Persistence helpers ---
  private saveUiState() {
    const state = {
      dateKey: this.getDateKey(new Date()),
      isClockedIn: this.isClockedIn,
      activeTimecardRecordId: this.activeTimecardRecordId,
      clockInStartedAtMs: this.clockInStartedAtMs,
      selectedJobRecordId: this.selectedJobRecordId,
      workflowLockedJobRecordId: this.workflowLockedJobRecordId
    };
    localStorage.setItem(HomePage.STORAGE_KEY, JSON.stringify(state));
  }

  private restoreUiState() {
    const raw = localStorage.getItem(HomePage.STORAGE_KEY);
    if (!raw) return;
    try {
      const state = JSON.parse(raw);
      if (state?.dateKey !== this.getDateKey(new Date())) {
        this.clearPersistedWorkflowState();
        return;
      }

      this.isClockedIn = !!state.isClockedIn;
      this.activeTimecardRecordId = state.activeTimecardRecordId || null;
      this.clockInStartedAtMs = Number.isFinite(state.clockInStartedAtMs)
        ? state.clockInStartedAtMs
        : null;
      this.selectedJobRecordId = state.selectedJobRecordId || null;
      this.workflowLockedJobRecordId = state.workflowLockedJobRecordId || null;

      if (this.isClockedIn && this.clockInStartedAtMs) {
        this.startClockTimer();
      } else {
        this.stopClockTimer();
        this.updateClockDashboardDisplay();
      }
    } catch {}
  }

  private saveJobActionIndexes() {
    if (!this.serviceOrders) return;
    const jobIndexes: Record<string, { actionIndex: number; isPaused: boolean }> = {};
    for (const job of this.serviceOrders) {
      const id = this.getJobRecordId(job);
      if (id) {
        jobIndexes[id] = {
          actionIndex: job._jobActionIndex || 0,
          isPaused: !!job._isPaused,
        };
      }
    }
    localStorage.setItem(HomePage.JOB_INDEX_STORAGE_KEY, JSON.stringify(jobIndexes));
  }

  private restoreJobActionIndexes() {
    if (!this.serviceOrders) return;
    const raw = localStorage.getItem(HomePage.JOB_INDEX_STORAGE_KEY);
    if (!raw) return;
    try {
      const jobIndexes = JSON.parse(raw);
      for (const job of this.serviceOrders) {
        const id = this.getJobRecordId(job);
        if (id && jobIndexes[id] !== undefined) {
          const savedValue = jobIndexes[id];
          if (typeof savedValue === 'number') {
            // Backward compatibility with older persisted format.
            job._jobActionIndex = savedValue;
            job._isPaused = false;
            continue;
          }

          job._jobActionIndex = savedValue?.actionIndex || 0;
          job._isPaused = !!savedValue?.isPaused;
        }
      }
    } catch {}
  }

  private computeJobActionIndexFromStatus(job: any): number {
    try {
      const raw = (job?.status || job?.['11']?.value || '').toString().trim().toLowerCase();
      const compact = raw.replace(/[-_\s]+/g, '');
      if (!raw) return 0;

      if (raw.includes('in progress') || raw === 'in progress' || compact === 'inprogress') {
        return 2; // COMPLETE button
      }

      if (raw.includes('en route') || raw === 'enroute' || raw === 'en route' || compact === 'enroute') {
        return 1; // ARRIVE button
      }

      // For statuses that represent completed/inspected/estimated/sold, keep index at 0
      // and rely on isJobComplete to prevent action.
      return 0;
    } catch {
      return 0;
    }
  }

  private clearPersistedWorkflowState() {
    this.isClockedIn = false;
    this.activeTimecardRecordId = null;
    this.clockInStartedAtMs = null;
    this.stopClockTimer();
    this.updateClockDashboardDisplay();
    this.selectedJobRecordId = null;
    this.workflowLockedJobRecordId = null;
    localStorage.removeItem(HomePage.STORAGE_KEY);
    localStorage.removeItem(HomePage.JOB_INDEX_STORAGE_KEY);
  }

  exitToLogin() {
    if (!this.isClockedIn) {
      this.selectedJobRecordId = null;
      this.workflowLockedJobRecordId = null;
    }

    this.saveUiState();
    this.stopClockTimer();
    this.authService.logout();
    this.router.navigate(['/login'], { replaceUrl: true });
  }

  private getDateKey(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getSelectedJob() {
    return this.serviceOrders?.find((job) => this.isSelectedJob(job)) || null;
  }

  private getJobRecordId(job: any) {
    return job?.['3']?.value?.toString() || '';
  }

  private getInspectionCacheStorageKey(serviceOrderId: string) {
    return `${HomePage.INSPECTION_CACHE_PREFIX}${(serviceOrderId || '').trim()}`;
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

  private hasEstimateDraft(jobRecordId: string): boolean {
    const id = (jobRecordId || '').trim();
    if (!id) {
      return false;
    }

    const storageKey = `${HomePage.ESTIMATE_DRAFT_STORAGE_KEY_PREFIX}${id}`;
    const raw = localStorage.getItem(storageKey);
    return !!raw;
  }

  private getDraftStateForJob(jobRecordId: string): boolean {
    return this.hasEstimateDraft(jobRecordId);
  }

  private persistInspectionCache(serviceOrderId: string, submissionPayload: any) {
    const id = (serviceOrderId || '').trim();
    if (!id) {
      return;
    }

    const cacheData = {
      serviceOrderId: id,
      masterJobRecordValues: submissionPayload?.masterJobRecordValues || {},
      photoBatchData: submissionPayload?.photoBatchData || { tableId: 'bv3mp7tra', rows: [] },
      photoCount: Array.isArray(submissionPayload?.photoBatchData?.rows)
        ? submissionPayload.photoBatchData.rows.length
        : 0,
      cachedAt: new Date().toISOString(),
    };

    const compactCacheData = {
      serviceOrderId: id,
      masterJobRecordValues: submissionPayload?.masterJobRecordValues || {},
      photoBatchData: { tableId: 'bv3mp7tra', rows: [] },
      photoCount: cacheData.photoCount,
      cachedAt: cacheData.cachedAt,
    };

    const storageKey = this.getInspectionCacheStorageKey(id);

    try {
      localStorage.setItem(storageKey, JSON.stringify(cacheData));
      return;
    } catch (error) {
      if (!this.isStorageQuotaExceededError(error)) {
        console.warn('Failed to persist inspection cache.', error);
        return;
      }

      console.warn('Inspection cache exceeded localStorage quota. Retrying with compact cache payload.', {
        serviceOrderId: id,
        photoCount: cacheData.photoCount,
      });
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify(compactCacheData));
      return;
    } catch (error) {
      if (!this.isStorageQuotaExceededError(error)) {
        console.warn('Failed to persist compact inspection cache.', error);
        return;
      }

      this.evictOldInspectionCaches(id);
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify(compactCacheData));
    } catch (error) {
      console.warn('Failed to persist compact inspection cache after cleanup. Continuing without cache persistence.', error);
    }
  }

  private evictOldInspectionCaches(retainServiceOrderId: string) {
    const retainKey = this.getInspectionCacheStorageKey(retainServiceOrderId);
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(HomePage.INSPECTION_CACHE_PREFIX) || key === retainKey) {
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

  private isIndexedDbAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private openInspectionDraftDb(): Promise<IDBDatabase | null> {
    if (!this.isIndexedDbAvailable()) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const request = indexedDB.open(
        HomePage.INSPECTION_DRAFT_DB_NAME,
        HomePage.INSPECTION_DRAFT_DB_VERSION
      );

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HomePage.INSPECTION_PHOTO_STORE_NAME)) {
          db.createObjectStore(HomePage.INSPECTION_PHOTO_STORE_NAME, {
            keyPath: 'serviceOrderId',
          });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('Unable to open IndexedDB for inspection draft photos.', request.error);
        resolve(null);
      };
    });
  }

  private async readInspectionPhotosFromIndexedDb(serviceOrderId: string): Promise<any | null> {
    const id = (serviceOrderId || '').trim();
    if (!id) {
      return null;
    }

    const db = await this.openInspectionDraftDb();
    if (!db) {
      return null;
    }

    try {
      const row = await new Promise<any>((resolve, reject) => {
        const tx = db.transaction(HomePage.INSPECTION_PHOTO_STORE_NAME, 'readonly');
        const store = tx.objectStore(HomePage.INSPECTION_PHOTO_STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('IndexedDB photo draft read failed.'));
      });

      return row?.inspectionPhotoState || null;
    } catch (error) {
      console.warn('Failed reading inspection photos from IndexedDB.', error);
      return null;
    } finally {
      db.close();
    }
  }

  private async deleteInspectionPhotoDraftFromIndexedDb(serviceOrderId: string): Promise<void> {
    const id = (serviceOrderId || '').trim();
    if (!id) {
      return;
    }

    const db = await this.openInspectionDraftDb();
    if (!db) {
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(HomePage.INSPECTION_PHOTO_STORE_NAME, 'readwrite');
        const store = tx.objectStore(HomePage.INSPECTION_PHOTO_STORE_NAME);
        store.delete(id);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB photo draft delete failed.'));
      });
    } catch (error) {
      console.warn('Failed clearing inspection photo draft from IndexedDB.', error);
    } finally {
      db.close();
    }
  }

  private applyInspectionValuesToJob(serviceOrderId: string, masterJobRecordValues: Record<string, any>) {
    const id = (serviceOrderId || '').trim();
    if (!id || !masterJobRecordValues || typeof masterJobRecordValues !== 'object') {
      return;
    }

    const targetJob = this.serviceOrders?.find((job) => this.getJobRecordId(job) === id);
    if (!targetJob) {
      return;
    }

    Object.entries(masterJobRecordValues).forEach(([fid, value]) => {
      targetJob[String(fid)] = {
        ...(targetJob[String(fid)] || {}),
        value: value === null || value === undefined ? '' : String(value),
      };
    });
  }

async ngOnInit() {
    console.log('Home Page Initializing...'); 
    const userData = this.authService.getUser();
    if (!userData) {
      this.router.navigate(['/login'], { replaceUrl: true });
      return;
    }

    console.log('Verified Employee ID (FID 3):', userData[3]?.value);
    this.getLocalWeather(); // Fetch weather on page load

    if (userData) {
      this.tech = {
        id: userData[3]?.value, // FID 3
        firstName: userData[6]?.value,
        lastName: userData[7]?.value,
        phone: userData[9]?.value,
        role: (userData?.role || userData?.['role']?.value || '').toString().trim()
      };

// --- Live Backend Timecard Restoration Guard ---
      try {
        console.log('> [Timecard Check] Querying backend proxy for active session...');
        const activeShiftCheck: any = await this.authService.checkActiveTimecardSession(this.tech.id, this.today.toISOString().split('T')[0]);

        // --- LITERAL PAYLOAD DIAGNOSTIC LOGS ---
        console.log('> [Timecard Check] RAW RESPONSE OBJECT RECEIVED:', activeShiftCheck);
        console.log('> [Timecard Check] shiftContext nested check:', activeShiftCheck?.shiftContext);
        console.log('> [Timecard Check] isClockedIn value:', activeShiftCheck?.shiftContext?.isClockedIn);
        // ----------------------------------------
        
        // FIX: Drill directly into the backend's shiftContext payload wrapper!
        if (activeShiftCheck && activeShiftCheck.shiftContext && activeShiftCheck.shiftContext.isClockedIn) {
          const shift = activeShiftCheck.shiftContext;
          console.log('> [Timecard Check] Open row found in Quickbase! Restoring Clock-Out view. RecID:', shift.recordId);
          
          this.isClockedIn = true;
          this.activeTimecardRecordId = shift.recordId;
          
          if (shift.clockInTime) {
            const dateStr = this.today.toISOString().split('T')[0];
            this.clockInStartedAtMs = new Date(`${dateStr}T${shift.clockInTime}`).getTime();
          }

          // Force the visual display templates to rebuild right now
          this.updateClockDashboardDisplay();
          this.startClockTimer();
          
        } else {
          console.log('> [Timecard Check] No active row found in database for today.');
          this.isClockedIn = false;
          this.activeTimecardRecordId = null;
          this.clockInStartedAtMs = null;
          this.updateClockDashboardDisplay();
        }
      } catch (err) {
        console.error('> [Timecard Check] Active query failed to resolve:', err);
        this.updateClockDashboardDisplay();
      }

      const rawHours = userData[42]?.value;
      if (rawHours && !isNaN(Number(rawHours))) {
        this.hoursWorked = (Number(rawHours) / (rawHours > 10000 ? 3600000 : 1)).toFixed(2); 
      } else {
        this.hoursWorked = '0.00';
      }
      this.ptoAvailable = userData[39]?.value || '0'; 
      
      console.log('Fetching schedule for Tech ID:', this.tech.id);
      await this.fetchScheduleForDate(this.today);

      if (this.isClockedIn && this.clockInStartedAtMs) {
        this.startClockTimer();
      } else {
        this.updateClockDashboardDisplay();
      }
    }
  }

  async ionViewWillEnter() {
    if (!this.tech?.id) {
      return;
    }

    this.viewEnterCount++;
    await this.fetchScheduleForDate(this.today);
    this.refreshDraftStateCache();
    this.serviceOrders = this.serviceOrders ? [...this.serviceOrders] : null;
    this.changeDetectorRef.detectChanges();
  }

  private refreshDraftStateCache() {
    if (!this.serviceOrders) {
      this.draftStateCache = {};
      return;
    }

    this.draftStateCache = {};
    this.serviceOrders.forEach((job) => {
      const jobRecordId = this.getJobRecordId(job);
      if (jobRecordId) {
        const hasDraft = this.hasEstimateDraft(jobRecordId);
        this.draftStateCache[jobRecordId] = hasDraft;
      }
    });
  }

  ngOnDestroy() {
    this.stopClockTimer();
    // Auto-clear dev-mode mock coordinates on page exit
    localStorage.removeItem('trmGeoMockCoordinates');
  }

  private startClockTimer() {
    this.stopClockTimer();
    this.updateClockDashboardDisplay();
    this.clockTimerId = window.setInterval(() => {
      this.updateClockDashboardDisplay();
    }, 60000);
  }

  private stopClockTimer() {
    if (this.clockTimerId !== null) {
      clearInterval(this.clockTimerId);
      this.clockTimerId = null;
    }
  }

  private updateClockDashboardDisplay() {
    if (!this.isClockedIn || !this.clockInStartedAtMs) {
      this.clockedInAtText = 'Not clocked in';
      this.timeOnClockText = 'Time on Clock: 0h 0m';
      return;
    }

    const startedAt = new Date(this.clockInStartedAtMs);
    const elapsedMs = Math.max(0, Date.now() - this.clockInStartedAtMs);
    const elapsedMinutes = Math.floor(elapsedMs / 60000);
    const hours = Math.floor(elapsedMinutes / 60);
    const minutes = elapsedMinutes % 60;

    this.clockedInAtText = `Clocked in at ${startedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    this.timeOnClockText = `Time on Clock: ${hours}h ${minutes}m`;
  }

  openDirections(job: any) {
    const street1 = (job?.['106']?.value || '').toString().trim();
    const street2 = (job?.['107']?.value || '').toString().trim();
    const city = (job?.['92']?.value || '').toString().trim();
    const zip = (job?.['105']?.value || '').toString().trim();

    const line1 = [street1, street2].filter(Boolean).join(' ');
    const fullAddress = [line1, city, zip].filter(Boolean).join(', ');

    if (!fullAddress) {
      console.warn('No address found for directions.');
      return;
    }

    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`;
    window.open(mapsUrl, '_blank');
  }

  getPhoneNumber(job: any): string {
    return (job?.['95']?.value || '').toString().trim();
  }

  getMobilePhone(job: any): string {
    return (job?.['96']?.value || '').toString().trim();
  }

  getEmailAddress(job: any): string {
    return (job?.['142']?.value || job?.['57']?.value || '').toString().trim();
  }

  getDialHref(rawPhone: string): string {
    const digitsOnly = (rawPhone || '').replace(/[^0-9+]/g, '');
    return digitsOnly ? `tel:${digitsOnly}` : '';
  }

  getMailHref(rawEmail: string): string {
    const email = (rawEmail || '').toString().trim();
    return email ? `mailto:${email}` : '';
  }

  hasDifferentPhoneNumbers(job: any): boolean {
    const phone = this.getPhoneNumber(job);
    const mobile = this.getMobilePhone(job);
    return !!mobile && mobile !== phone;
  }

  isInProgressJob(job: any): boolean {
    const status = (job?.['11']?.value || '').toString().trim().toLowerCase();
    if (status === 'in progress') {
      return true;
    }

    if (this.workflowLockedJobRecordId === this.getJobRecordId(job)) {
      return (job?._jobActionIndex || 0) === 2;
    }

    return false;
  }

  getViewJobButtonLabel(job: any): string {
    if (this.isInspectedJob(job)) {
      const jobRecordId = this.getJobRecordId(job);
      if (this.draftStateCache[jobRecordId]) {
        return 'RESUME ESTIMATE';
      }
      return 'START ESTIMATE';
    }

    return this.isInProgressJob(job) ? 'RETURN TO HUB' : 'VIEW JOB';
  }

  isViewJobButtonDisabled(job: any): boolean {
    if (this.isClockedIn) {
      return false;
    }

    // When clocked out, only VIEW JOB is allowed.
    return this.isInspectedJob(job) || this.isInProgressJob(job);
  }

  viewJob(job: any) {
    const jobRecordId = this.getJobRecordId(job);
    if (!jobRecordId) {
      console.warn('Unable to open job detail: missing record id.');
      return;
    }

    if (this.isViewJobButtonDisabled(job)) {
      return;
    }

    if (this.isInspectedJob(job)) {
      this.openEstimate(jobRecordId, job);
      return;
    }

    const shouldResumeWorkflow = this.isInProgressJob(job);
    const mode: 'view' | 'work' = shouldResumeWorkflow ? 'work' : 'view';
    const isPaused = !!job?._isPaused;
    this.openJobDetail(jobRecordId, mode, isPaused);
  }

  private openEstimate(jobRecordId: string, job: any) {
    const inspectionCache = this.readInspectionCache(jobRecordId);
    this.router.navigate(['/estimate', jobRecordId], {
      state: { job, inspectionCache }
    });
  }

  private openJobDetail(jobRecordId: string, mode: 'view' | 'work', paused = false) {
    localStorage.setItem(HomePage.ACTIVE_JOB_ID_STORAGE_KEY, jobRecordId);
    localStorage.setItem(HomePage.ACTIVE_JOB_MODE_STORAGE_KEY, mode);
    localStorage.setItem(HomePage.ACTIVE_JOB_PAUSED_STORAGE_KEY, paused ? '1' : '0');
    this.router.navigate(['/job-detail', jobRecordId], {
      queryParams: { mode, paused: paused ? '1' : '0' },
    });
  }

  private async getCurrentCoordinates(): Promise<string> {
    // Dev mode: allow mocking coordinates via localStorage
    // When mocking, high accuracy setting is irrelevant (no geolocation call is made)
    const mockCoords = localStorage.getItem('trmGeoMockCoordinates');
    if (mockCoords) {
      console.log('Using mock coordinates:', mockCoords);
      return mockCoords;
    }

    const bestFix = await this.getBestGeolocationFix();
    if (!bestFix) {
      return 'Unavailable';
    }

    const lat = bestFix.latitude.toFixed(7);
    const lon = bestFix.longitude.toFixed(7);
    console.log('Geolocation fix accuracy (meters):', Math.round(bestFix.accuracyMeters));
    return `${lat},${lon}`;
  }

  private async getBestGeolocationFix(): Promise<{
    latitude: number;
    longitude: number;
    accuracyMeters: number;
  } | null> {
    if (!navigator.geolocation) {
      return null;
    }

    return new Promise((resolve) => {
      let bestPosition: GeolocationPosition | null = null;
      const startedAt = Date.now();
      let didResolve = false;
      let watchId: number | null = null;

      const finalize = (position: GeolocationPosition | null) => {
        if (didResolve) {
          return;
        }
        didResolve = true;
        if (watchId !== null) {
          navigator.geolocation.clearWatch(watchId);
        }
        if (!position) {
          resolve(null);
          return;
        }
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
        });
      };

      const onPosition = (position: GeolocationPosition) => {
        if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) {
          bestPosition = position;
        }
        const isAccurateEnough = position.coords.accuracy <= this.geolocationTargetAccuracyMeters;
        const hasSampledLongEnough = Date.now() - startedAt >= this.geolocationSampleWindowMs;
        if (isAccurateEnough || hasSampledLongEnough) {
          finalize(bestPosition);
        }
      };

      const onError = () => {
        finalize(bestPosition);
      };


      // LocalStorage override for high accuracy (dev/prod safe)
      let enableHighAccuracy: boolean;
      const force = localStorage.getItem('trmGeoForceHighAccuracy');
      if (force === 'true') {
        enableHighAccuracy = true;
      } else if (force === 'false') {
        enableHighAccuracy = false;
      } else {
        // Platform check: disable high accuracy for desktop (non-mobile)
        const isMobile = /Android|iPhone|iPad|iPod|Mobile|IEMobile|BlackBerry|Opera Mini/i.test(navigator.userAgent);
        enableHighAccuracy = isMobile;
      }
      console.log('Geolocation userAgent:', navigator.userAgent);
      console.log('Geolocation enableHighAccuracy:', enableHighAccuracy);
      const geoOptions: PositionOptions = {
        enableHighAccuracy,
        timeout: this.geolocationHardTimeoutMs,
        maximumAge: 0,
      };

      watchId = navigator.geolocation.watchPosition(onPosition, onError, geoOptions);
      setTimeout(() => finalize(bestPosition), this.geolocationHardTimeoutMs);
    });
  }
}