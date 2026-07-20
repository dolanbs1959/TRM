const fs = require('fs');
const path = require('path');
const functions = require('firebase-functions');
const { onRequest } = require('firebase-functions/v2/https');
const express = require('express');
const cors = require('cors')({ origin: true });
const axios = require('axios');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium').default;
const { generatePDFHtml } = require('./pdfGenerator');
const { generateTechSheetHtml } = require('./techSheetGenerator');
const { generateInvoiceHtml } = require('./invoiceGenerator');
const { getTaxRate } = require('./taxUtility');
const { defineSecret } = require('firebase-functions/params');
const RingCentralSDK = require('@ringcentral/sdk').SDK;
const { sendSms } = require('./ringcentral');

const googleMapsApiKey = defineSecret('GOOGLE_MAPS_API_KEY');
const rcClientId = defineSecret('RC_CLIENT_ID');
const rcClientSecret = defineSecret('RC_CLIENT_SECRET');
const rcJwt = defineSecret('RC_JWT');
const pipelineSecret = defineSecret('PIPELINE_SECRET');

const app = express();
    app.use((req, res, next) => {
        console.log(`[DEBUG-REQUEST] Incoming ${req.method} ${req.url}`);
        next();
    });
app.use(cors);
app.use(express.json({ limit: '50mb' }));
// Add middleware to log all incoming requests
app.use((req, res, next) => {
    console.log('[REQUEST]', {
        method: req.method,
        path: req.path,
        url: req.url,
        timestamp: new Date().toISOString()
    });
    next();
});
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- TRM CONFIGURATION ---
const QB_TOKEN = 'b7gwzr_dcp8_0_cz4tixhc9iqfwwcxner7xzrwb46';
const QB_REALM_HOST = 'bobfaulk.quickbase.com'; // Updated Realm
const QB_API_ENDPOINT = 'https://api.quickbase.com/v1'; // REST API Base

const TABLES = {
    CUSTOMERS: 'bt73uh9ez',
    EMPLOYEES: 'bt73uh9mx',
    SERVICE_ORDERS: 'bt73uh9kh',
    SERVICE_ORDER_TASKS: 'bt73wgry8',
    SERVICE_ORDER_ROOFS: (process.env.QB_SERVICE_ORDER_ROOFS_TABLE || 'bt73v6is2').trim(),
    LOCATIONS: (process.env.QB_LOCATIONS_TABLE || process.env.QB_LOCATION_TABLE || '').trim(),
    ESTIMATE_LINE_ITEMS: 'buukg8qpp',
    OFFERED_SERVICE_ITEMS: (process.env.QB_OFFERED_SERVICE_ITEMS_TABLE || 'bv2q8iy3d').trim(),
    JOB_PHOTOS: 'bv3mp7tra',
    ASSIGNED_TECHNICIANS: 'bt73yx4vc',
    EMPLOYEE_TIMECARDS: 'bt73uh9p8',
    WORKFLOW_LOGS: 'bv3dpfek5',
    ROOFS: 'bt73uh9ie',
    ROOF_MATERIALS: 'bt73z2v2f',
    ROOF_TYPES: 'bt73zrwzg',
    ROOF_BRANDS: 'bt73zxre4',
    ROOF_COLORS: 'bt73zt6cf',
    INVOICES: 'bt73v82ts'
};

const WRITABLE_FIELDS = ['3', '61', '63', '64', '66', '68', '70'];

const TIMECARD_FIELDS = {
    RELATED_EMPLOYEE_NUMERIC: 6,
    DATE: 7,
    CLOCK_IN_TIME: 8,
    CLOCK_OUT_TIME: 9,
    CLOCK_IN_COORDINATES: 10,
    CLOCK_OUT_COORDINATES: 18,
    // Set these to your Employee Timecards table FIDs for milestone timestamps.
    JOB_COMPLETE_AT: null,
    JOB_RETURN_REQUIRED_AT: null
};

const WORKFLOW_LOG_FIELDS = {
    EVENT_TYPE: 6,
    EVENT_TIMESTAMP: 7,
    GPS_COORDINATES: 8,
    NOTES: 9,
    RELATED_SERVICE_ORDER: 10,
    RELATED_EMPLOYEE: 11,
    SMS_STATUS: 15
};

const ASSIGNED_TECH_FIELDS = {
    RELATED_SERVICE_ORDER: 9,
    ASSIGNMENT_STATUS: 8,
    RELATED_EMPLOYEE: 11
};

const SERVICE_ORDER_STATUS_SYNC_FIELDS = {
    PARENT_STATUS: 11,
    TOTAL_TECHS_ASSIGNED: 113,
    CREWS_DISPATCHED: 114,
    CREWS_ARRIVED: 115,
    CREWS_COMPLETED: 116,
    CREWS_RETURN_REQUIRED: 117
};

const ASSIGNMENT_STATUS_BY_ACTION = {
    DISPATCH: 'Dispatched',
    ARRIVED: 'Arrived',
    COMPLETE: 'Completed',
    RETURN_REQUIRED: 'Return Required'
};

const ACTION_ALIASES = {
    ARRIVAL: 'ARRIVED',
    PAUSE: 'PAUSED',
    RESUME: 'RESUMED'
};

const ACTIONS_WITHOUT_ASSIGNMENT_STATUS_UPDATE = new Set(['PAUSED', 'RESUMED']);

function getFieldValue(record, fid) {
    return record?.[String(fid)]?.value;
}

function normalizeStage(value) {
    return (value || '').toString().trim().toLowerCase();
}

function toDateKey(value) {
    console.log('[DateKey][Incoming]', { type: typeof value, rawValue: value });

    // Unwrap Quickbase object envelopes: { value: '...' } or { text: '...' }
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        value = value.value !== undefined ? value.value
              : value.text  !== undefined ? value.text
              : null;
        console.log('[DateKey][Unwrapped]', { unwrapped: value });
    }

    if (value === null || value === undefined || value === '') {
        console.log('[DateKey][Result]', { finalKey: null, reason: 'empty after unwrap' });
        return null;
    }

    // Helper to format a real Date object safely to Pacific YYYY-MM-DD
    const formatToPacific = (dateObj) => {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const parts = formatter.formatToParts(dateObj);
        const yyyy = parts.find(p => p.type === 'year').value;
        const mm = parts.find(p => p.type === 'month').value;
        const dd = parts.find(p => p.type === 'day').value;
        return `${yyyy}-${mm}-${dd}`;
    };

    // Native Date object
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            console.log('[DateKey][Result]', { finalKey: null, reason: 'invalid Date object' });
            return null;
        }
        const result = formatToPacific(value);
        console.log('[DateKey][Result]', { finalKey: result, via: 'Date object (Pacific Locked)' });
        return result;
    }

    // Numeric epoch (ms)
    if (typeof value === 'number') {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
            console.log('[DateKey][Result]', { finalKey: null, reason: 'invalid epoch number' });
            return null;
        }
        const result = formatToPacific(d);
        console.log('[DateKey][Result]', { finalKey: result, via: 'epoch number (Pacific Locked)' });
        return result;
    }

    // Strip to the date portion only: take everything before any T, space, or timezone indicator
    const text = value.toString().trim().split(/[T\s]/)[0].trim();
    console.log('[DateKey][Stripped]', { text });

    if (!text) {
        console.log('[DateKey][Result]', { finalKey: null, reason: 'empty after strip' });
        return null;
    }

    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        console.log('[DateKey][Result]', { finalKey: text, via: 'YYYY-MM-DD' });
        return text;
    }

    // MM-DD-YYYY or MM/DD/YYYY
    const slashDash = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (slashDash) {
        const [, mm, dd, yyyy] = slashDash;
        const result = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
        console.log('[DateKey][Result]', { finalKey: result, via: 'MM-DD-YYYY' });
        return result;
    }

    // YYYY/MM/DD
    const ymdSlash = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (ymdSlash) {
        const [, yyyy, mm, dd] = ymdSlash;
        const result = `${yyyy}-${mm}-${dd}`;
        console.log('[DateKey][Result]', { finalKey: result, via: 'YYYY/MM/DD' });
        return result;
    }

    // Last resort: standard Date parse (may behave UTC vs local depending on format)
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
        const yyyy = parsed.getUTCFullYear();
        const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(parsed.getUTCDate()).padStart(2, '0');
        const result = `${yyyy}-${mm}-${dd}`;
        console.log('[DateKey][Result]', { finalKey: result, via: 'Date.parse fallback', input: text });
        return result;
    }

    console.log('[DateKey][Result]', { finalKey: null, reason: 'unparseable', input: text });
    return null;
}

function matchesScheduleDate(record, selectedDate) {
    if (!selectedDate) return true;

    const recordId = (getFieldValue(record, 3) || '').toString();
    const rawInspectionDate = getFieldValue(record, 41);
    const rawServiceOrderDate = getFieldValue(record, 9);
    const inspectionDate = toDateKey(getFieldValue(record, 41));
    const serviceOrderDate = toDateKey(getFieldValue(record, 9));

    console.log('[Schedule][DateCheck]', {
        recordId,
        selectedDate,
        rawInspectionDate,
        parsedInspectionDate: inspectionDate,
        rawServiceOrderDate,
        parsedServiceOrderDate: serviceOrderDate
    });

    return inspectionDate === selectedDate || serviceOrderDate === selectedDate;
}

const SALES_ACTIVE_STATUSES = new Set(['scheduled', 'en route', 'in progress']);
const TECHNICIAN_ACTIVE_STATUSES = new Set(['sales', 'sold', 'en route', 'in progress']);

function normalizeRole(value) {
    return (value || '').toString().trim().toLowerCase();
}

function getLifecycleSetForRecord(role, record) {
    const normalizedRole = normalizeRole(role);
    const hasSalesRole = normalizedRole.includes('sales');
    const hasTechnicianRole = normalizedRole.includes('technician');
    const recordId = (getFieldValue(record, 3) || '').toString();

    if (hasSalesRole && hasTechnicianRole) {
        const mergedSet = new Set([...SALES_ACTIVE_STATUSES, ...TECHNICIAN_ACTIVE_STATUSES]);
        console.log('[Schedule][RoleLifecycleMap]', {
            recordId,
            incomingRole: role || '',
            normalizedRole,
            allowedStatuses: Array.from(mergedSet)
        });
        return mergedSet;
    }

    if (hasSalesRole) {
        console.log('[Schedule][RoleLifecycleMap]', {
            recordId,
            incomingRole: role || '',
            normalizedRole,
            allowedStatuses: Array.from(SALES_ACTIVE_STATUSES)
        });
        return SALES_ACTIVE_STATUSES;
    }

    if (hasTechnicianRole) {
        console.log('[Schedule][RoleLifecycleMap]', {
            recordId,
            incomingRole: role || '',
            normalizedRole,
            allowedStatuses: Array.from(TECHNICIAN_ACTIVE_STATUSES)
        });
        return TECHNICIAN_ACTIVE_STATUSES;
    }

    // If role is missing/unrecognized, allow the broad active lifecycle set.
    const fallbackSet = new Set([...SALES_ACTIVE_STATUSES, ...TECHNICIAN_ACTIVE_STATUSES]);
    console.log('[Schedule][RoleLifecycleMap]', {
        recordId,
        incomingRole: role || '',
        normalizedRole,
        allowedStatuses: Array.from(fallbackSet)
    });
    return fallbackSet;
}

function matchesRoleLifecycleStatus(record, role) {
    const status = (getFieldValue(record, 11) || '').toString().trim().toLowerCase();
    if (!status) {
        return false;
    }

    const lifecycleSet = getLifecycleSetForRecord(role, record);
    return lifecycleSet.has(status);
}

function getStopNumber(record) {
    const rawValue = getFieldValue(record, 108);
    const stopNumber = Number.parseInt(rawValue, 10);

    return Number.isFinite(stopNumber) ? stopNumber : Number.MAX_SAFE_INTEGER;
}

function isTruthyQuickbaseValue(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return value === 1;
    }

    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'checked';
}

function parseNumericValue(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }

    const cleaned = String(value || '').replace(/[^0-9.-]/g, '').trim();
    if (!cleaned) {
        return 0;
    }

    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueNonEmptyStrings(values) {
    const seen = new Set();
    const output = [];

    for (const value of values || []) {
        const normalized = String(value || '').trim();
        if (!normalized) {
            continue;
        }

        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        output.push(normalized);
    }

    return output;
}

function parseStrictNumericId(rawValue) {
    const normalized = String(rawValue ?? '').trim();
    if (!/^\d+$/.test(normalized)) {
        return null;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWorkflowEventType(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    const normalizedAction = raw.toUpperCase().replace(/[\s-]+/g, '_');
    const action = ACTION_ALIASES[normalizedAction] || normalizedAction;

    if (action === 'COMPLETE') {
        return 'Complete';
    }

    if (action === 'ARRIVED') {
        return 'Arrival';
    }

    if (action === 'DISPATCH') {
        return 'Dispatch';
    }

    if (action === 'RETURN_REQUIRED') {
        return 'Return Required';
    }

    if (action === 'PAUSED') {
        return 'Pause';
    }

    if (action === 'RESUMED') {
        return 'Resume';
    }

    return raw;
}

function normalizeWorkflowAction(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    const normalized = raw.toUpperCase().replace(/[\s-]+/g, '_');
    return ACTION_ALIASES[normalized] || normalized;
}

function toNonNegativeInt(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildQuickbaseHeaders() {
    return {
        'QB-Realm-Hostname': QB_REALM_HOST,
        'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
    };
}

function hasQuickbaseLineErrors(response) {
    const status = Number(response?.status);
    const lineErrors = Array.isArray(response?.data?.metadata?.lineErrors)
        ? response.data.metadata.lineErrors
        : [];

    return status === 207 || lineErrors.length > 0;
}

async function writeQuickbaseRecords(tableId, rows, fieldsToReturn = [3]) {
    const payload = {
        to: tableId,
        data: rows,
        fieldsToReturn
    };

    const response = await axios.post(`${QB_API_ENDPOINT}/records`, payload, {
        headers: buildQuickbaseHeaders()
    });

    if (hasQuickbaseLineErrors(response)) {
        const lineErrors = response?.data?.metadata?.lineErrors;
        throw new Error(`Quickbase returned line errors while writing to table ${tableId}: ${JSON.stringify(lineErrors || {})}`);
    }

    return response;
}

async function deleteQuickbaseRecords(tableId, recordIds) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) {
        console.log('[QuickbaseDelete] No record IDs provided, skipping deletion');
        return;
    }

    const payload = {
        from: tableId,
        where: `{'3'.EX.${recordIds.join('.OR.')}}`
    };

    try {
        const response = await axios.delete(`${QB_API_ENDPOINT}/records`, {
            data: payload,
            headers: buildQuickbaseHeaders()
        });

        console.log('[QuickbaseDelete] Deletion completed', {
            tableId,
            recordIds,
            status: response.status,
            deletedCount: recordIds.length
        });

        return response;
    } catch (error) {
        console.error('[QuickbaseDelete] Deletion failed', {
            tableId,
            recordIds,
            error: error.message
        });
        throw error;
    }
}

async function queryEstimateLineItemsByServiceOrder(serviceOrderId) {
    const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
    if (!Number.isFinite(normalizedServiceOrderId)) {
        console.warn('[EstimateLineItemsQuery] Invalid serviceOrderId');
        return [];
    }

    try {
        const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.ESTIMATE_LINE_ITEMS,
            select: [3],
            where: `{'13'.EX.${normalizedServiceOrderId}}`
        }, {
            headers: buildQuickbaseHeaders()
        });

        const records = Array.isArray(response?.data?.data) ? response.data.data : [];
        const recordIds = records.map(record => record['3']?.value).filter(id => Number.isFinite(id));

        console.log('[EstimateLineItemsQuery] Query completed', {
            serviceOrderId: normalizedServiceOrderId,
            foundCount: recordIds.length,
            recordIds
        });

        return recordIds;
    } catch (error) {
        console.error('[EstimateLineItemsQuery] Query failed', {
            serviceOrderId: normalizedServiceOrderId,
            error: error.message
        });
        return [];
    }
}

async function queryServiceOrderRoofsByServiceOrder(serviceOrderId) {
    const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
    if (!Number.isFinite(normalizedServiceOrderId)) {
        console.warn('[ServiceOrderRoofsQuery] Invalid serviceOrderId');
        return [];
    }

    try {
        const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.SERVICE_ORDER_ROOFS,
            select: [3],
            where: `{'24'.EX.${normalizedServiceOrderId}}`
        }, {
            headers: buildQuickbaseHeaders()
        });

        const records = Array.isArray(response?.data?.data) ? response.data.data : [];
        const recordIds = records.map(record => record['3']?.value).filter(id => Number.isFinite(id));

        console.log('[ServiceOrderRoofsQuery] Query completed', {
            serviceOrderId: normalizedServiceOrderId,
            foundCount: recordIds.length,
            recordIds
        });

        return recordIds;
    } catch (error) {
        console.error('[ServiceOrderRoofsQuery] Query failed', {
            serviceOrderId: normalizedServiceOrderId,
            error: error.message
        });
        return [];
    }
}

async function completeEstimateTechnicianAssignment(serviceOrderId, employeeId) {
    const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
    const normalizedEmployeeId = Number.parseInt(employeeId, 10);

    if (!Number.isFinite(normalizedServiceOrderId) || !Number.isFinite(normalizedEmployeeId)) {
        console.warn('[Estimate][AssignmentCompletion][InvalidIdentifiers]', {
            serviceOrderId,
            employeeId
        });
        return;
    }

    const assignmentQuery = {
        from: TABLES.ASSIGNED_TECHNICIANS,
        select: [3, ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER, ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE, ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS],
        where: `{'${ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER}'.EX.'${normalizedServiceOrderId}'}AND{'${ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE}'.EX.'${normalizedEmployeeId}'}`
    };

    const assignmentResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, assignmentQuery, {
        headers: buildQuickbaseHeaders()
    });

    const assignedRecords = Array.isArray(assignmentResponse?.data?.data) ? assignmentResponse.data.data : [];
    if (assignedRecords.length === 0) {
        console.warn('[Estimate][AssignmentCompletion][NoMatchingAssignment]', {
            serviceOrderId: normalizedServiceOrderId,
            employeeId: normalizedEmployeeId
        });
        return;
    }

    const updateRows = assignedRecords
        .map((record) => {
            const recordId = Number.parseInt(getFieldValue(record, 3), 10);
            if (!Number.isFinite(recordId)) {
                return null;
            }
            return {
                3: { value: recordId },
                [ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS]: { value: ASSIGNMENT_STATUS_BY_ACTION.COMPLETE }
            };
        })
        .filter(Boolean);

    if (updateRows.length === 0) {
        console.warn('[Estimate][AssignmentCompletion][NoUpdatableRecords]', {
            serviceOrderId: normalizedServiceOrderId,
            employeeId: normalizedEmployeeId
        });
        return;
    }

    await writeQuickbaseRecords(TABLES.ASSIGNED_TECHNICIANS, updateRows, [3, ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS]);
    console.log('[Estimate][AssignmentCompletion][MarkedComplete]', {
        serviceOrderId: normalizedServiceOrderId,
        employeeId: normalizedEmployeeId,
        updatedAssignmentCount: updateRows.length
    });
}

function normalizeEstimateSubmissionMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'sold' || normalized === 'ready' || normalized === 'customer_ready_to_begin') {
        return 'sold';
    }

    return 'estimated';
}

function normalizeEstimateLineItems(items, serviceOrderId) {
    const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
    if (!Number.isFinite(normalizedServiceOrderId)) {
        throw new Error('serviceOrderId must be numeric');
    }

    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('activeEstimateItems must be a non-empty array');
    }

    return items.map((item, index) => {
        const qty = Number.parseFloat(item?.qtyNeeded);
        const price = Number.parseFloat(item?.price);
        const sqFootage = Number.parseFloat(item?.sqFootage);
        const lineSubtotal = Number.parseFloat(item?.lineSubtotal);
        const normalizedUnit = String(item?.unit || '').trim().toLowerCase();
        const isSquareMeasure = /\bsq\b/.test(normalizedUnit) || normalizedUnit.includes('square');
        const normalizedQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
        const normalizedSqFootage = Number.isFinite(sqFootage) && sqFootage > 0 ? sqFootage : 0;
        const normalizedPrice = Number.isFinite(price) ? price : 0;
        const normalizedLineSubtotal = Number.isFinite(lineSubtotal)
            ? lineSubtotal
            : normalizedQty * normalizedPrice * (isSquareMeasure ? normalizedSqFootage : 1);

        return {
            [13]: { value: normalizedServiceOrderId },
            [20]: { value: 'Submitted' },
            [17]: { value: Number.parseInt(item?.id, 10) || 0 },
            [19]: { value: String(item?.description || item?.name || '').trim() },
            [16]: { value: normalizedQty },
            [23]: { value: normalizedSqFootage },
            [18]: { value: normalizedPrice },
            [24]: { value: normalizedLineSubtotal },
            [29]: { value: String(item?.specialInstructions || '').trim() }
        };
    });
}

function normalizeRoofRecordIds(roofRecordIds) {
    if (!Array.isArray(roofRecordIds) || roofRecordIds.length === 0) {
        return [];
    }

    return Array.from(new Set(
        roofRecordIds
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isFinite(value))
    ));
}

async function uploadQuickbasePdfAttachment(serviceOrderId, fieldId, filename, pdfContent) {
    const hasSupportedContent = Buffer.isBuffer(pdfContent) || pdfContent instanceof Uint8Array;
    if (!hasSupportedContent || pdfContent.length === 0) {
        throw new Error(`Cannot upload ${filename}: PDF content is missing, unsupported, or empty`);
    }

    const uploadBuffer = Buffer.from(pdfContent);
    const qbPayload = {
        to: TABLES.SERVICE_ORDERS,
        data: [{
            3: { value: Number.parseInt(serviceOrderId, 10) },
            [fieldId]: { value: { fileName: filename, data: uploadBuffer.toString('base64') } }
        }]
    };
    await axios.post(`${QB_API_ENDPOINT}/records`, qbPayload, { headers: buildQuickbaseHeaders() });
}

async function generateAndDispatchPDF(payload) {
    try {
        console.log('[BackgroundWorker] Starting PDF generation and dispatch (v2)...');
        console.log('[BackgroundWorker] Payload:', {
            serviceOrderId: payload.serviceOrderId,
            locationEmail: payload.locationEmail,
            hasLineItems: !!payload.activeEstimateItems?.length,
            lineItemCount: payload.activeEstimateItems?.length || 0,
            hasRoofStructures: !!payload.roofStructures?.length,
            roofStructureCount: payload.roofStructures?.length || 0,
            totalSquareFootage: payload.totalSquareFootage
        });

        // Check environment variables
        console.log('[BackgroundWorker] Environment check:', {
            hasEmailUser: !!process.env.EMAIL_USER,
            hasEmailPass: !!process.env.EMAIL_PASS
        });

        // Setup Nodemailer transporter
        const transporter = nodemailer.createTransport({
            host: 'smtp.ionos.com',
            port: 465,
            secure: true, // Forces SSL authentication protocol
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        // Transform payload to match pdfGenerator expected format
        const job = {
            '3': payload.serviceOrderId,
            '93': payload.customerName?.split(' ')[0] || '',
            '94': payload.customerName?.split(' ').slice(1).join(' ') || '',
            '106': payload.locationAddress || '',
            '92': '', // Will be extracted from locationAddress if needed
            '105': '', // Will be extracted from locationAddress if needed
            '142': payload.locationEmail || '',
            '95': payload.customerPhone || ''
        };

        const lineItems = payload.activeEstimateItems?.map(item => ({
            qty: item.qtyNeeded || 1,
            unitPrice: item.amount || 0,
            uom: item.uom || 'ea',
            sqFootage: item.sqFootage || 0,
            description: item.description || 'Item',
            specialInstructions: String(item.specialInstructions || '').trim()
        })) || [];

        const signatureData = payload.digitalSignatureDataUrl || null;
        const roofStructures = payload.roofStructures || [];
        const totalSquareFootage = payload.totalSquareFootage || 0;
        const serviceNotes = payload.serviceNotes || '';
        const cleanMaintenanceScheduledFor = payload.cleanMaintenanceScheduledFor || '';
        const repairServicesScheduledFor = payload.repairServicesScheduledFor || '';
        const inspectionPhotos = payload.inspectionPhotos || [];
        const msDiscountAmount = payload.msDiscountAmount || 0;
        const otherDiscountAmount = payload.otherDiscountAmount || 0;

        // Generate HTML using the pdfGenerator
        console.log('[BackgroundWorker] Generating HTML...');
        const htmlContent = await generatePDFHtml(job, lineItems, signatureData, roofStructures, totalSquareFootage, serviceNotes, cleanMaintenanceScheduledFor, repairServicesScheduledFor, inspectionPhotos, msDiscountAmount, otherDiscountAmount);
        console.log('[BackgroundWorker] HTML generated, length:', htmlContent.length);

        // Launch Puppeteer to generate PDF in memory
        console.log('[BackgroundWorker] Launching Puppeteer...');
        let browser = null;
        let pdfBuffer = null;
        try {
        // Consolidate the configuration into one clean definition
        const executablePath =
            process.env.FUNCTIONS_EMULATOR === 'true'
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            : await chromium.executablePath();

        browser = await puppeteer.launch({
            executablePath, // Uses the single declaration above
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });            
        console.log('[BackgroundWorker] Puppeteer launched');
            const page = await browser.newPage();
            console.log('[BackgroundWorker] Setting page content...');
            await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
            console.log('[BackgroundWorker] Generating PDF...');
            pdfBuffer = await page.pdf({ format: 'A4' });
            console.log('[BackgroundWorker] PDF compiled successfully in memory, size:', pdfBuffer.length);
        } finally {
            if (browser) {
                await browser.close();
                console.log('[BackgroundWorker] Puppeteer closed');
            }
        }

        const filename = `Estimate_${payload.serviceOrderId}.pdf`;

        // Parallel execution for email and upload
        const tasks = [];

        // Hand the PDF binary directly to the transactional email service
        if (payload.locationEmail) {
            console.log('[BackgroundWorker] Preparing email to:', payload.locationEmail);
            console.log('[BackgroundWorker] Queuing PDF handover to transactional email service...');
            const isSold = payload.submissionMode === 'sold';

            const formatEmailDate = (value) => {
                const raw = String(value || '').trim();
                if (!raw) return 'TBD';
                const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                return match ? `${match[2]}-${match[3]}-${match[1]}` : raw;
            };

            const emailSubject = isSold
                ? 'Thank You for Choosing The Roof Medic'
                : 'Your Roof Medic Estimate is Ready';

            const emailHtml = isSold
                ? `
                    <p>Dear ${payload.customerFirstName || payload.customerName},</p>

                    <p>Thank you for choosing The Roof Medic. We appreciate your business.</p>

                    <p>Attached is a copy of your signed estimate for your records.</p>

                    <p>Your scheduled services are:</p>

                    <p><strong>Roof Cleaning &amp; Maintenance:</strong> ${formatEmailDate(payload.cleanMaintenanceScheduledFor)}</p>

                    <p><strong>Repair Services:</strong> ${formatEmailDate(payload.repairServicesScheduledFor)}</p>

                    <p>If the scheduled dates need to change, our office will contact you promptly.</p>

                    <p>If you have any questions before your scheduled service, or if you need to reschedule, simply reply to this email or contact our office.</p>

                    <p>We look forward to serving you.</p>

                    <p>Sincerely,</p>

                    <p><strong>The Roof Medic</strong><br>
                    253-862-4412</p>
                    `
                : `
                    <p>Dear ${payload.customerFirstName || payload.customerName},</p>

                    <p>Thank you for choosing The Roof Medic to inspect your roof.</p>

                    <p>Attached is your detailed estimate outlining our recommended services and pricing. Please take a few moments to review it at your convenience.</p>

                    <p>If you have any questions about the recommendations or would like to discuss your options, we're here to help. Simply reply to this email or contact our office.</p>

                    <p>We appreciate the opportunity to earn your business and look forward to serving you.</p>

                    <p>Sincerely,</p>

                    <p><strong>The Roof Medic</strong><br>
                    253-862-4412<br>
                    contact@yourroofmedic.com</p>
                    `;

            const mailOptions = {
                from: '"The Roof Medic Estimates" <' + process.env.EMAIL_USER + '>',
                to: payload.locationEmail,
                subject: emailSubject,
                html: emailHtml,
                attachments: [
                    {
                        filename: filename,
                        content: pdfBuffer
                    }
                ]
            };

            tasks.push(transporter.sendMail(mailOptions).then(() => {
                console.log('[BackgroundWorker] Email dispatched successfully to', payload.locationEmail);
            }).catch((error) => {
                console.error('[BackgroundWorker] Email send failed:', error);
                throw error;
            }));
        } else {
            console.warn('[BackgroundWorker] No email provided, skipping email dispatch.');
        }

        // Explicitly await the email dispatch prior to uploading
        // We wait for tasks up to this point to guarantee sequencing
        await Promise.allSettled(tasks).then(results => {
             results.forEach((result, idx) => {
                 if (result.status === 'rejected') {
                     console.error(`[BackgroundWorker] Task ${idx} failed:`, result.reason);
                 }
             });
        });

        // Verify PDF before uploading
        if (!pdfBuffer || pdfBuffer.length === 0) {
            throw new Error('[BackgroundWorker] PDF buffer is empty or corrupted, aborting upload.');
        }
        console.log(`[BackgroundWorker] PDF buffer verified, size: ${pdfBuffer.length} bytes.`);

        // Upload PDF to Quickbase (Field ID:144 on SERVICE_ORDERS table)
        if (payload.serviceOrderId) {
            console.log('[BackgroundWorker] Queuing non-blocking Quickbase API record update to upload PDF asset...');

            // Explicitly clone the buffer stream to ensure it is isolated and fully finalized
            // before base64 encoding, preventing the race condition with the email tasks.
            try {
                await uploadQuickbasePdfAttachment(payload.serviceOrderId, 144, filename, pdfBuffer);
                console.log('[BackgroundWorker] PDF asset uploaded to Quickbase master record successfully.');
            } catch (qbErr) {
                console.error('[BackgroundWorker] Quickbase PDF upload failed:', qbErr);
            }
        } else {
             console.warn('[BackgroundWorker] No service order ID provided, skipping Quickbase upload.');
        }

    } catch (err) {
            // Force the full error object and stack trace to appear
            console.error('[BackgroundWorker][FATAL_FAILURE]', {
                message: err.message,
                stack: err.stack,
                cause: err.cause,
                code: err.code
            });
        }
}

async function handleSubmitEstimateData(req, res) {
    console.log('[DEBUG-TRIGGER] Submit Estimate endpoint was called');
    const inboundBody = req.body && typeof req.body === 'object' ? req.body : {};
    console.log('[Estimate][InboundBodyShape]', {
        topLevelKeys: Object.keys(inboundBody),
        submissionMode: inboundBody.submissionMode || inboundBody.customerReadyToBegin,
        activeEstimateItemsCount: Array.isArray(inboundBody.activeEstimateItems) ? inboundBody.activeEstimateItems.length : 0,
        roofRecordIdsCount: Array.isArray(inboundBody.roofRecordIds) ? inboundBody.roofRecordIds.length : 0
    });

    const {
        serviceOrderId,
        locationRecordId,
        locationEmail,
        customerRecordId,
        employeeId,
        roofRecordIds,
        submissionMode,
        customerReadyToBegin,
        digitalSignatureDataUrl,
        activeEstimateItems,
        subtotal,
        taxAmount,
        totalAmount,
        secondaryDiscountAmount,
        secondaryDiscountPercentage,
        msDiscountAmount,
        otherDiscountAmount,
        serviceNotes,
        cleanMaintenanceScheduledFor,
        repairServicesScheduledFor,
        isEstimateRevision
    } = inboundBody;

    const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
    if (!Number.isFinite(normalizedServiceOrderId)) {
        return res.status(400).json({ success: false, message: 'serviceOrderId must be numeric' });
    }

    const normalizedLocationRecordId = Number.parseInt(locationRecordId, 10);
    if (!Number.isFinite(normalizedLocationRecordId)) {
        return res.status(400).json({ success: false, message: 'locationRecordId must be numeric' });
    }

    const normalizedLocationEmail = String(locationEmail || '').trim();
    if (!normalizedLocationEmail) {
        return res.status(400).json({ success: false, message: 'locationEmail is required' });
    }

    const normalizedCustomerRecordId = Number.parseInt(customerRecordId, 10);

    const normalizedSubmissionMode = normalizeEstimateSubmissionMode(
        customerReadyToBegin ? 'sold' : submissionMode
    );
    const shouldRequireSignature = normalizedSubmissionMode === 'sold';
    const normalizedSignatureDataUrl = String(digitalSignatureDataUrl || '').trim();

    if (shouldRequireSignature && !normalizedSignatureDataUrl) {
        return res.status(400).json({ success: false, message: 'digitalSignatureDataUrl is required for sold submissions' });
    }

    const normalizedSubtotal = parseNumericValue(subtotal);
    const normalizedTaxAmount = parseNumericValue(taxAmount);
    const normalizedTotalAmount = parseNumericValue(totalAmount);
    const normalizedSecondaryDiscountAmount = parseNumericValue(secondaryDiscountAmount);
    const normalizedSecondaryDiscountPercentage = parseNumericValue(secondaryDiscountPercentage);
    const normalizedMSDiscountAmount = parseNumericValue(msDiscountAmount);
    const normalizedOtherDiscountAmount = parseNumericValue(otherDiscountAmount);
    const estimateRows = normalizeEstimateLineItems(activeEstimateItems, normalizedServiceOrderId);
    const normalizedRoofRecordIds = normalizeRoofRecordIds(roofRecordIds);
    const nextStatus = normalizedSubmissionMode === 'sold' ? 'Sold' : 'Estimated';
    const nextWorkflowAction = normalizedSubmissionMode === 'sold'
        ? 'Email Signed Estimate'
        : 'Email for Signature';

    try {
        if (Number.isFinite(normalizedCustomerRecordId)) {
            await writeQuickbaseRecords(TABLES.CUSTOMERS, [{
                3: { value: normalizedCustomerRecordId },
                8: { value: normalizedLocationEmail }
            }], [3, 8]);
            console.log('[Estimate][CustomerEmailSync]', {
                customerRecordId: normalizedCustomerRecordId,
                updatedEmail: normalizedLocationEmail
            });
        } else {
            console.warn('[Estimate][CustomerEmailSyncSkipped]', {
                reason: 'customerRecordId missing or invalid',
                customerRecordId,
                submittedEmail: normalizedLocationEmail
            });
        }

        const serviceOrderUpdate = {
            3: { value: normalizedServiceOrderId },
            11: { value: nextStatus },
            137: { value: normalizedSubtotal },
            66: { value: normalizedTaxAmount },
            67: { value: normalizedTotalAmount },
            83: { value: normalizedSecondaryDiscountAmount },
            154: { value: String(inboundBody.cleanMaintenanceScheduledFor || '') },
            155: { value: String(inboundBody.repairServicesScheduledFor || '') },
            73: { value: String(inboundBody.serviceNotes || '') }
        };

        if (normalizedSubmissionMode === 'sold') {
            serviceOrderUpdate[69] = { value: new Date().toISOString().split('T')[0] };
            serviceOrderUpdate[40] = { value: 'Service Order' };
        }

        await writeQuickbaseRecords(TABLES.SERVICE_ORDERS, [serviceOrderUpdate], [3, 11, 137, 66, 67, 83, 154, 155, 73, 69, 40]);

        // Handle estimate revision: delete existing data before inserting new ones
        if (isEstimateRevision === true) {
            console.log('[EstimateRevision] Revision mode detected, deleting existing data', {
                serviceOrderId: normalizedServiceOrderId
            });

            try {
                // Delete existing estimate line items by relationship field (field 13)
                console.log('[EstimateRevision] Deleting line items by service order ID', {
                    serviceOrderId: normalizedServiceOrderId
                });

                const lineItemDeletePayload = {
                    from: TABLES.ESTIMATE_LINE_ITEMS,
                    where: `{'13'.EX.${normalizedServiceOrderId}}`
                };

                const lineItemDeleteResponse = await axios.delete(`${QB_API_ENDPOINT}/records`, {
                    data: lineItemDeletePayload,
                    headers: buildQuickbaseHeaders()
                });

                console.log('[EstimateRevision][DELETE Response] Line items deletion response', {
                    serviceOrderId: normalizedServiceOrderId,
                    status: lineItemDeleteResponse.status,
                    statusText: lineItemDeleteResponse.statusText,
                    headers: lineItemDeleteResponse.headers,
                    responseBody: lineItemDeleteResponse.data,
                    metadata: lineItemDeleteResponse.data?.metadata,
                    lineErrors: lineItemDeleteResponse.data?.metadata?.lineErrors,
                    deletedRecordCount: lineItemDeleteResponse.data?.metadata?.deletedRecordCount || lineItemDeleteResponse.data?.deletedRecordCount
                });

                // Verification query: confirm records are actually gone
                const verificationLineItemIds = await queryEstimateLineItemsByServiceOrder(normalizedServiceOrderId);
                console.log('[EstimateRevision][Verification] Line items after deletion', {
                    serviceOrderId: normalizedServiceOrderId,
                    remainingCount: verificationLineItemIds.length,
                    remainingRecordIds: verificationLineItemIds
                });

                // Delete existing service order roof associations by relationship field (field 24)
                console.log('[EstimateRevision] Deleting service order roofs by service order ID', {
                    serviceOrderId: normalizedServiceOrderId
                });

                const serviceOrderRoofDeletePayload = {
                    from: TABLES.SERVICE_ORDER_ROOFS,
                    where: `{'24'.EX.${normalizedServiceOrderId}}`
                };

                const serviceOrderRoofDeleteResponse = await axios.delete(`${QB_API_ENDPOINT}/records`, {
                    data: serviceOrderRoofDeletePayload,
                    headers: buildQuickbaseHeaders()
                });

                console.log('[EstimateRevision][DELETE Response] Service order roofs deletion response', {
                    serviceOrderId: normalizedServiceOrderId,
                    status: serviceOrderRoofDeleteResponse.status,
                    statusText: serviceOrderRoofDeleteResponse.statusText,
                    headers: serviceOrderRoofDeleteResponse.headers,
                    responseBody: serviceOrderRoofDeleteResponse.data,
                    metadata: serviceOrderRoofDeleteResponse.data?.metadata,
                    lineErrors: serviceOrderRoofDeleteResponse.data?.metadata?.lineErrors,
                    deletedRecordCount: serviceOrderRoofDeleteResponse.data?.metadata?.deletedRecordCount || serviceOrderRoofDeleteResponse.data?.deletedRecordCount
                });

                // Verification query: confirm records are actually gone
                const verificationServiceOrderRoofIds = await queryServiceOrderRoofsByServiceOrder(normalizedServiceOrderId);
                console.log('[EstimateRevision][Verification] Service order roofs after deletion', {
                    serviceOrderId: normalizedServiceOrderId,
                    remainingCount: verificationServiceOrderRoofIds.length,
                    remainingRecordIds: verificationServiceOrderRoofIds
                });

                // Delete existing PDF file attachment from FID144 (all versions)
                // DISABLED: QuickBase maintains file revision history automatically.
                // Uploading a new PDF creates a new revision and older revisions are purged
                // by QuickBase according to the field's revision limit.
                // Code left in place for future reference if needed.
                /*
                console.log('[EstimateRevision] Deleting PDF file attachment from FID144');
                const serviceOrderFileDeletePayload = {
                    to: TABLES.SERVICE_ORDERS,
                    data: [
                        {
                            3: { value: normalizedServiceOrderId },
                            144: { value: '' }
                        }
                    ],
                    fieldsToReturn: [3, 144]
                };

                await axios.post(`${QB_API_ENDPOINT}/records`, serviceOrderFileDeletePayload, {
                    headers: buildQuickbaseHeaders()
                });
                console.log('[EstimateRevision] PDF file attachment deleted successfully');
                */

            } catch (deletionError) {
                console.error('[EstimateRevision] Failed to delete existing data', {
                    serviceOrderId: normalizedServiceOrderId,
                    error: deletionError.message
                });
                return res.status(500).json({
                    success: false,
                    message: 'Failed to delete existing estimate data during revision. Please try again.'
                });
            }
        }

        const lineItemResponse = await writeQuickbaseRecords(TABLES.ESTIMATE_LINE_ITEMS, estimateRows, [3, 29]);
        const insertedLineItemCount = Array.isArray(lineItemResponse?.data?.data)
            ? lineItemResponse.data.data.length
            : estimateRows.length;

        // Verification query: confirm new line items exist after insertion
        const afterInsertionLineItemIds = await queryEstimateLineItemsByServiceOrder(normalizedServiceOrderId);
        console.log('[EstimateRevision][Verification] Line items after insertion', {
            serviceOrderId: normalizedServiceOrderId,
            totalCount: afterInsertionLineItemIds.length,
            recordIds: afterInsertionLineItemIds
        });

        let insertedServiceOrderRoofCount = 0;
        if (normalizedRoofRecordIds.length > 0) {
            const serviceOrderRoofRows = normalizedRoofRecordIds.map((roofRecordId) => {
                return {
                    22: { value: roofRecordId },
                    24: { value: normalizedServiceOrderId }
                };
            });

            const serviceOrderRoofResponse = await writeQuickbaseRecords(
                TABLES.SERVICE_ORDER_ROOFS,
                serviceOrderRoofRows,
                [3, 22, 24]
            );

            insertedServiceOrderRoofCount = Array.isArray(serviceOrderRoofResponse?.data?.data)
                ? serviceOrderRoofResponse.data.data.length
                : serviceOrderRoofRows.length;

            console.log('[Estimate][ServiceOrderRoofsJoin][InsertSuccess]', {
                serviceOrderId: normalizedServiceOrderId,
                insertedServiceOrderRoofCount,
                roofRecordIds: normalizedRoofRecordIds
            });

            // Verification query: confirm new service order roofs exist after insertion
            const afterInsertionServiceOrderRoofIds = await queryServiceOrderRoofsByServiceOrder(normalizedServiceOrderId);
            console.log('[EstimateRevision][Verification] Service order roofs after insertion', {
                serviceOrderId: normalizedServiceOrderId,
                totalCount: afterInsertionServiceOrderRoofIds.length,
                recordIds: afterInsertionServiceOrderRoofIds
            });
        }

        try {
            await completeEstimateTechnicianAssignment(normalizedServiceOrderId, employeeId);
        } catch (assignmentError) {
            console.warn('[Estimate][AssignmentCompletion][Failure]', {
                serviceOrderId: normalizedServiceOrderId,
                employeeId,
                message: assignmentError?.message || String(assignmentError)
            });
        }

        // Trigger the detached asynchronous execution block
        console.log('[Estimate] About to call generateAndDispatchPDF with serviceOrderId:', normalizedServiceOrderId);
        console.log('[Estimate] Calling PDF generation with updated Puppeteer config for cloud compatibility');
        await generateAndDispatchPDF({
            serviceOrderId: normalizedServiceOrderId,
            locationEmail: normalizedLocationEmail,
            subtotal: normalizedSubtotal,
            taxAmount: normalizedTaxAmount,
            totalAmount: normalizedTotalAmount,
            msDiscountAmount: normalizedMSDiscountAmount,
            otherDiscountAmount: normalizedOtherDiscountAmount,
            activeEstimateItems: estimateRows.map((row, index) => ({
                description: activeEstimateItems[index]?.description || 'Item',
                qtyNeeded: activeEstimateItems[index]?.qtyNeeded || row['16']?.value || 1,
                amount: activeEstimateItems[index]?.price || row['14']?.value || 0,
                uom: activeEstimateItems[index]?.uom || 'ea',
                sqFootage: activeEstimateItems[index]?.sqFootage || row['23']?.value || 0,
                specialInstructions: String(activeEstimateItems[index]?.specialInstructions || '').trim()
            })),
            submissionMode: normalizedSubmissionMode,
            customerFirstName: inboundBody.customerFirstName || '',
            customerName: inboundBody.customerName || 'Valued Customer',
            locationAddress: inboundBody.locationAddress || 'N/A',
            customerPhone: inboundBody.customerPhone || 'N/A',
            digitalSignatureDataUrl: normalizedSignatureDataUrl || null,
            submissionDate: new Date().toLocaleDateString(),
            roofStructures: inboundBody.roofStructures || [],
            totalSquareFootage: inboundBody.totalSquareFootage || 0,
            serviceNotes: serviceNotes || '',
            cleanMaintenanceScheduledFor: cleanMaintenanceScheduledFor || '',
            repairServicesScheduledFor: repairServicesScheduledFor || '',
            inspectionPhotos: inboundBody.inspectionPhotos || []
        });
        
        console.log('[Estimate] generateAndDispatchPDF called (async, non-blocking)');

        return res.json({
            success: true,
            recordId: String(normalizedServiceOrderId),
            locationRecordId: String(normalizedLocationRecordId),
            status: nextStatus,
            nextWorkflowAction,
            insertedLineItemCount,
            insertedServiceOrderRoofCount
        });
    } catch (error) {
        console.error('[Estimate][Submit][UnhandledError]', {
            status: error?.response?.status,
            responseData: error?.response?.data,
            message: error?.message,
            stack: error?.stack
        });
        console.error('[Estimate][Submit][UnhandledError][JSON]', JSON.stringify({
            status: error?.response?.status,
            responseData: error?.response?.data,
            message: error?.message,
            stack: error?.stack
        }));
        return res.status(500).json({ success: false, message: 'Error submitting estimate data' });
    }
}

function hasParentSummaryFields(record) {
    if (!record || typeof record !== 'object') {
        return false;
    }

    return [
        SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS,
        SERVICE_ORDER_STATUS_SYNC_FIELDS.TOTAL_TECHS_ASSIGNED,
        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_DISPATCHED,
        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_ARRIVED,
        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_COMPLETED,
        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_RETURN_REQUIRED
    ].every((fid) => Object.prototype.hasOwnProperty.call(record, String(fid)));
}

function extractParentStatusSummaryFromChildRecord(record) {
    if (!record) {
        return null;
    }

    return {
        parentStatus: String(getFieldValue(record, SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS) || '').trim(),
        totalTechsAssigned: toNonNegativeInt(getFieldValue(record, SERVICE_ORDER_STATUS_SYNC_FIELDS.TOTAL_TECHS_ASSIGNED)),
        crewsDispatched: toNonNegativeInt(getFieldValue(record, SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_DISPATCHED)),
        crewsArrived: toNonNegativeInt(getFieldValue(record, SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_ARRIVED)),
        crewsCompleted: toNonNegativeInt(getFieldValue(record, SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_COMPLETED)),
        crewsReturnRequired: toNonNegativeInt(getFieldValue(record, SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_RETURN_REQUIRED))
    };
}

function resolveParentStatusFromSummary(snapshot) {
    if (!snapshot) {
        return null;
    }

    if (snapshot.crewsReturnRequired > 0) {
        return 'Return Required';
    }

    if (snapshot.totalTechsAssigned <= 0) {
        return null;
    }

    if (snapshot.crewsCompleted === snapshot.totalTechsAssigned) {
        return 'Complete';
    }

    if (snapshot.crewsArrived === snapshot.totalTechsAssigned) {
        return 'In Progress';
    }

    if (snapshot.crewsDispatched === snapshot.totalTechsAssigned) {
        return 'En Route';
    }

    return null;
}

function getParentSyncRuleLabel(snapshot, resolvedStatus) {
    if (!snapshot || !resolvedStatus) {
        return null;
    }

    if (resolvedStatus === 'Return Required' && snapshot.crewsReturnRequired > 0) {
        return 'RULE_A_ROADBLOCK_OVERRIDE';
    }

    if (resolvedStatus === 'Complete') {
        return 'RULE_B_COMPLETE_EQUALS_TOTAL';
    }

    if (resolvedStatus === 'In Progress') {
        return 'RULE_B_ARRIVED_EQUALS_TOTAL';
    }

    if (resolvedStatus === 'En Route') {
        return 'RULE_B_DISPATCHED_EQUALS_TOTAL';
    }

    return 'RULE_UNSPECIFIED';
}

async function createWorkflowLogRecord({
    eventType,
    eventTimestamp,
    gpsCoordinates,
    notes,
    relatedServiceOrder,
    relatedEmployee
}) {
    const normalizedEventType = normalizeWorkflowEventType(eventType);
    if (!normalizedEventType) {
        throw new Error('workflow eventType is required');
    }

    const normalizedServiceOrder = Number.parseInt(relatedServiceOrder, 10);
    if (!Number.isFinite(normalizedServiceOrder)) {
        throw new Error('workflow related service order must be numeric');
    }

    const normalizedEmployee = parseStrictNumericId(relatedEmployee);

    const normalizedTimestamp = eventTimestamp
        ? new Date(eventTimestamp).toISOString()
        : new Date().toISOString();

    if (!normalizedTimestamp || normalizedTimestamp === 'Invalid Date') {
        throw new Error('workflow event timestamp is invalid');
    }

    const row = {};
    row[WORKFLOW_LOG_FIELDS.EVENT_TYPE] = { value: normalizedEventType };
    row[WORKFLOW_LOG_FIELDS.EVENT_TIMESTAMP] = { value: normalizedTimestamp };
    row[WORKFLOW_LOG_FIELDS.GPS_COORDINATES] = { value: String(gpsCoordinates || '') };
    row[WORKFLOW_LOG_FIELDS.NOTES] = { value: String(notes || '') };
    row[WORKFLOW_LOG_FIELDS.RELATED_SERVICE_ORDER] = { value: normalizedServiceOrder };
    if (Number.isFinite(normalizedEmployee) && normalizedEmployee > 0) {
        row[WORKFLOW_LOG_FIELDS.RELATED_EMPLOYEE] = { value: normalizedEmployee };
    }

    try {
        const response = await writeQuickbaseRecords(TABLES.WORKFLOW_LOGS, [row], [3]);
        // Log the full Quickbase response body to help debug missing records in the UI
        console.log('[WorkflowLog][WriteResponse]', {
            to: TABLES.WORKFLOW_LOGS,
            responseStatus: response?.status,
            responseData: response?.data
        });

        return response?.data || null;
    } catch (err) {
        console.error('[WorkflowLog][WriteError]', {
            to: TABLES.WORKFLOW_LOGS,
            message: err?.message,
            responseStatus: err?.response?.status,
            responseData: err?.response?.data
        });
        throw err;
    }
}

async function getEtaMinutes(originCoords, { destLat, destLng, destAddress } = {}) {
    const origin = String(originCoords || '').trim();

    if (!origin || origin === 'Unavailable') {
        return { etaMinutes: null, diagnostic: 'Technician GPS coordinates unavailable.' };
    }

    const [originLat, originLng] = origin.split(',').map(Number);
    if (!Number.isFinite(originLat) || !Number.isFinite(originLng)) {
        return { etaMinutes: null, diagnostic: `GPS coordinates are not valid lat/lon: "${origin}".` };
    }

    const parsedDestLat = Number(destLat);
    const parsedDestLng = Number(destLng);
    const useCoords = Number.isFinite(parsedDestLat) && Number.isFinite(parsedDestLng)
        && !(parsedDestLat === 0 && parsedDestLng === 0);

    const resolvedDestAddress = String(destAddress || '').trim();
    if (!useCoords && !resolvedDestAddress) {
        return { etaMinutes: null, diagnostic: 'Destination coordinates and address are both unavailable.' };
    }

    const destinationBody = useCoords
        ? { location: { latLng: { latitude: parsedDestLat, longitude: parsedDestLng } } }
        : { address: resolvedDestAddress };

    const diagnosticSource = useCoords ? 'stored coordinates' : `address "${resolvedDestAddress}"`;

    try {
        const routesResponse = await axios.post(
            'https://routes.googleapis.com/directions/v2:computeRoutes',
            {
                origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
                destination: destinationBody,
                travelMode: 'DRIVE',
                routingPreference: 'TRAFFIC_AWARE'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': googleMapsApiKey.value(),
                    'X-Goog-FieldMask': 'routes.duration'
                },
                timeout: 8000
            }
        );

        const durationSeconds = routesResponse?.data?.routes?.[0]?.duration;
        if (!durationSeconds) {
            const body = JSON.stringify(routesResponse?.data || {});
            return { etaMinutes: null, diagnostic: `Routes API returned no duration using ${diagnosticSource}. Response: ${body.slice(0, 200)}` };
        }

        const seconds = Number.parseInt(String(durationSeconds).replace(/[^0-9]/g, ''), 10);
        if (!Number.isFinite(seconds) || seconds <= 0) {
            return { etaMinutes: null, diagnostic: `Routes API returned unparseable duration value: "${durationSeconds}".` };
        }

        const minutes = Math.round(seconds / 60);
        return { etaMinutes: minutes, diagnostic: null };
    } catch (err) {
        const status = err?.response?.status;
        const body = JSON.stringify(err?.response?.data || {});
        const detail = status ? `Routes API returned ${status} using ${diagnosticSource}. ${body.slice(0, 200)}` : err.message;
        return { etaMinutes: null, diagnostic: detail };
    }
}

async function patchWorkflowLog(workflowLogRecordId, fields) {
    if (!Number.isFinite(workflowLogRecordId) || workflowLogRecordId <= 0) {
        console.warn('[WorkflowLog][Patch] Skipping patch — record ID unavailable', { workflowLogRecordId });
        return;
    }

    const row = Object.assign({ 3: { value: workflowLogRecordId } }, fields);
    const response = await writeQuickbaseRecords(TABLES.WORKFLOW_LOGS, [row], [3]);
    console.log('[WorkflowLog][Patch] Record patched', {
        workflowLogRecordId,
        fields: Object.keys(fields),
        responseStatus: response?.status
    });
}

async function resolveLookupRecordId(tableId, labelFid, rawLabel, entityName) {
    const label = String(rawLabel || '').trim();
    if (!label) {
        return null;
    }

    const escapedLabel = label.replace(/'/g, "\\'");
    const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
        from: tableId,
        select: [3, labelFid],
        where: `{\'${labelFid}\'.EX.\'${escapedLabel}\'}`
    }, {
        headers: {
            'QB-Realm-Hostname': QB_REALM_HOST,
            'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
        }
    });

    const recordId = response?.data?.data?.[0]?.['3']?.value;
    if (!Number.isFinite(Number(recordId))) {
        throw new Error(`No ${entityName} lookup record found for label: ${label}`);
    }

    return Number.parseInt(recordId, 10);
}

async function tryResolveLookupRecordId(tableId, labelFid, rawLabel) {
    const label = String(rawLabel || '').trim();
    if (!label) {
        return null;
    }

    try {
        const recordId = await resolveLookupRecordId(tableId, labelFid, label, 'lookup');
        return Number.isFinite(recordId) ? recordId : null;
    } catch (error) {
        return null;
    }
}

async function queryActiveLookupOptions(tableId, labelFid, activeFid) {
    const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
        from: tableId,
        select: [3, labelFid, activeFid]
    }, {
        headers: {
            'QB-Realm-Hostname': QB_REALM_HOST,
            'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
        }
    });

    const records = Array.isArray(response?.data?.data) ? response.data.data : [];
    const activeValues = records
        .filter((record) => isTruthyQuickbaseValue(record?.[String(activeFid)]?.value))
        .map((record) => record?.[String(labelFid)]?.value);

    return uniqueNonEmptyStrings(activeValues);
}

async function queryActiveLookupOptionRecords(tableId, labelFid, activeFid) {
    const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
        from: tableId,
        select: [3, labelFid, activeFid]
    }, {
        headers: {
            'QB-Realm-Hostname': QB_REALM_HOST,
            'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
        }
    });

    const records = Array.isArray(response?.data?.data) ? response.data.data : [];
    return records
        .filter((record) => isTruthyQuickbaseValue(record?.[String(activeFid)]?.value))
        .map((record) => ({
            id: Number.parseInt(record?.['3']?.value, 10),
            label: String(record?.[String(labelFid)]?.value || '').trim()
        }))
        .filter((record) => Number.isFinite(record.id) && !!record.label);
}

async function queryRoofPitchChoices() {
    try {
        const response = await axios.get(`${QB_API_ENDPOINT}/fields`, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            },
            params: {
                tableId: TABLES.ROOFS
            }
        });

        const fields = Array.isArray(response?.data)
            ? response.data
            : Array.isArray(response?.data?.fields)
                ? response.data.fields
                : [];

        const pitchField = fields.find((field) => Number(field?.id) === 63);
        const choices = Array.isArray(pitchField?.properties?.choices) ? pitchField.properties.choices : [];
        return uniqueNonEmptyStrings(choices);
    } catch (error) {
        console.warn('Roof Pitch Choices Query Error:', error.response ? error.response.data : error.message);
        return [];
    }
}

async function queryRoofAreaChoices() {
    try {
        const response = await axios.get(`${QB_API_ENDPOINT}/fields`, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            },
            params: {
                tableId: TABLES.ROOFS
            }
        });

        const fields = Array.isArray(response?.data)
            ? response.data
            : Array.isArray(response?.data?.fields)
                ? response.data.fields
                : [];

        const roofAreaField = fields.find((field) => Number(field?.id) === 60);
        const choices = Array.isArray(roofAreaField?.properties?.choices) ? roofAreaField.properties.choices : [];

        const normalizedChoices = uniqueNonEmptyStrings(choices);
        if (normalizedChoices.length > 0) {
            return normalizedChoices;
        }

        // Fallback for environments where FID 60 is not configured with static choices.
        const roofsResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.ROOFS,
            select: [60]
        }, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        const roofRecords = Array.isArray(roofsResponse?.data?.data) ? roofsResponse.data.data : [];
        const existingAreaValues = roofRecords.map((record) => record?.['60']?.value);
        return uniqueNonEmptyStrings(existingAreaValues);
    } catch (error) {
        console.warn('Roof Area Choices Query Error:', error.response ? error.response.data : error.message);
        return [];
    }
}

// --- API SAFEGUARD MIDDLEWARE ---
// This prevents "Double Taps" from hitting Quickbase twice in a row
// let lastCallTimestamp = 0;
// const CALL_THRESHOLD = 500; // 0.5 seconds

// app.use((req, res, next) => {
//     const now = Date.now();
//     if (now - lastCallTimestamp < CALL_THRESHOLD && req.method === 'POST') {
//         return res.status(429).send("Slow down! Preventing unnecessary API calls.");
//     }
//     lastCallTimestamp = now;
//     next();
// });

app.get('/satellite-image', async (req, res) => {
    try {
        const address = String(req.query.address || '').trim();

        if (!address) {
            return res.status(400).send('Missing address');
        }

        const url =
            `https://maps.googleapis.com/maps/api/staticmap` +
            `?center=${encodeURIComponent(address)}` +
            `&zoom=19` +
            `&size=640x640` +
            `&scale=2` +
            `&maptype=satellite` +
            `&key=${googleMapsApiKey.value()}`;

        const response = await axios.get(url, {
            responseType: 'arraybuffer'
        });

        res.set('Content-Type', response.headers['content-type']);
        res.send(response.data);

    } catch (err) {
        console.error('Satellite image error:', err.message);
        res.status(500).send('Unable to retrieve map.');
    }
});

// --- LOGIN HANDSHAKE ---
app.post('/login', async (req, res) => {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).send("Phone and PIN Required");

    try {
        const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.EMPLOYEES,
            // 42 = Accumulated Pay Period Hours, 39 = Available PTO, 17 = Role
            select: [3, 6, 7, 9, 17, 39, 42, 58, 66],
            where: `{'9'.EX.'${phone}'}AND{'58'.EX.'${pin}'}`
        }, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        if (response.data.data.length > 0) {
            const userData = response.data.data[0];
            const employeeRecordId = userData['3'].value;
            const todayStr = new Date().toISOString().split('T')[0];

            console.log(`> [Timecard][Login] Checking active status for Employee RecID: ${employeeRecordId} on Date: ${todayStr}`);

            let activeShift = null;
            let hasHistoricalOpenTimecard = false;

            try {
                const timecardCheck = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                    from: TABLES.EMPLOYEE_TIMECARDS,
                    select: [3, TIMECARD_FIELDS.DATE, TIMECARD_FIELDS.CLOCK_IN_TIME],
                    where: `{'${TIMECARD_FIELDS.RELATED_EMPLOYEE_NUMERIC}'.EX.${employeeRecordId}}AND{'${TIMECARD_FIELDS.CLOCK_OUT_TIME}'.EX.''}`
                }, {
                    headers: {
                        'QB-Realm-Hostname': QB_REALM_HOST,
                        'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                    }
                });

                console.log(`> [Timecard][Query] Quickbase rows found: ${timecardCheck.data.data.length}`);

                const openTimecards = timecardCheck.data.data;

                const todaysOpenTimecard = openTimecards.find(
                    row => row[TIMECARD_FIELDS.DATE]?.value === todayStr
                );

                hasHistoricalOpenTimecard =
                    openTimecards.length > 0 && !todaysOpenTimecard;

                if (todaysOpenTimecard) {
                    activeShift = {
                        recordId: String(todaysOpenTimecard['3'].value),
                        isClockedIn: true
                    };

                    console.log(`> [Timecard][Status] Tech is currently clocked in! Shift RecID: ${activeShift.recordId}`);
                } else if (hasHistoricalOpenTimecard) {
                    console.log(`> [Timecard][Status] Historical open timecard found.`);
                } else {
                    console.log(`> [Timecard][Status] No open timecard record found.`);
                }

            } catch (tcErr) {
                console.error("> [Timecard][Error] Failed checking active shift context row:", tcErr.message);
            }

            return res.json({
                success: true,
                user: userData,
                shiftContext: activeShift,
                hasHistoricalOpenTimecard
            });

        } else {
            return res.status(401).json({
                success: false,
                message: "Invalid Phone or PIN"
            });
        }

    } catch (error) {
        console.error("QB Error:", error.response ? error.response.data : error.message);
        return res.status(500).send("Internal Server Error");
    }
});

// --- GET TECHNICIAN SCHEDULE ---
app.post('/get-schedule', async (req, res) => {
    const { techId, date } = req.body;

    // console.log('============= EMULATOR INBOUND HANDSHAKE RECONCILIATION =============');
    // console.log('Incoming Request Body Params:', { techId, date });
    // console.log('Data Type of techId:', typeof techId);
    // console.log('Data Type of date:', typeof date);

    // console.log('Querying for techId:', techId, 'date:', date);

    if (!techId) return res.status(400).send("Technician ID Required");

    try {
        const normalizedTechId = parseStrictNumericId(techId);
        if (!Number.isFinite(normalizedTechId)) {
            return res.status(400).send('Technician ID must be numeric');
        }

        const assignmentWhere = `{'11'.EX.'${normalizedTechId}'}`;
        // console.log('Target Junction Query String value:', assignmentWhere);
        // console.log('--- EMULATOR OUTBOUND REST CLIENT HANDSHAKE ---');
        // console.log('Tech ID:', normalizedTechId, 'Selected Date:', date);
        // console.log('--- BACKEND DEBUG RECONCILIATION ---');
        // console.log('Raw req.body values parsed:', {
        //     techId: normalizedTechId,
        //     date,
        //     typeOfTechId: typeof normalizedTechId,
        //     typeOfDate: typeof date
        // });
        // console.log('Target Junction Table string value:', TABLES.ASSIGNED_TECHNICIANS);

        const assignmentQueryBody = {
            from: TABLES.ASSIGNED_TECHNICIANS,
            select: [8, 9, 11],
            where: assignmentWhere
        };
        // console.log('Assigned Technicians Query Payload:', JSON.stringify(assignmentQueryBody, null, 2));

        const assignmentResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, assignmentQueryBody, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        const assignmentRecords = Array.isArray(assignmentResponse?.data?.data) ? assignmentResponse.data.data : [];
        const assignmentStatusByServiceOrderId = new Map();
        const relatedServiceOrderIds = Array.from(new Set(
            assignmentRecords
                .map((record) => {
                    const soId = parseStrictNumericId(getFieldValue(record, ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER));
                    const status = getFieldValue(record, ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS);
                    if (Number.isFinite(soId)) {
                        assignmentStatusByServiceOrderId.set(String(soId), String(status || '').trim());
                    }
                    return soId;
                })
                .filter((recordId) => Number.isFinite(recordId))
        ));

        // console.log('[Schedule][AssignmentResults]', {
        //     techId: normalizedTechId,
        //     assignmentRows: assignmentRecords.length,
        //     relatedServiceOrderCount: relatedServiceOrderIds.length,
        //     relatedServiceOrderIds
        // });

        if (relatedServiceOrderIds.length === 0) {
            console.log('[Schedule][PipelineSummary]', {
                techId: normalizedTechId,
                selectedDate: date,
                keptRecords: 0,
                reason: 'no assigned service orders for technician'
            });

            return res.json([]);
        }

        const serviceOrderWhere = relatedServiceOrderIds
            .map((recordId) => `{'3'.EX.'${recordId}'}`)
            .join('OR');

        // console.log('Target Service Orders Query String value:', serviceOrderWhere);
        // console.log('Target Table string value:', TABLES.SERVICE_ORDERS);

        const debugBody = {
            from: TABLES.SERVICE_ORDERS,
            select: [3, 6, 7, 9, 10, 11, 12, 15, 16, 26, 40, 41, 44, 46, 70, 71, 90, 92, 93, 94, 95, 96, 105, 106, 107, 108, 110, 142, 157, 158],
            where: serviceOrderWhere
        };
        // console.log('Literal Quickbase API Request Payload Body Object:', JSON.stringify(debugBody, null, 2));

        const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, debugBody, {
            headers: { 
                'QB-Realm-Hostname': QB_REALM_HOST, 
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}` 
            }
        });

        const allAssignedRecords = Array.isArray(response.data.data) ? response.data.data : [];
        // console.log('============= QUICKBASE API RESPONSE DATA =============');
        // console.log('Total Rows Returned Natively from Quickbase:', allAssignedRecords.length);
        // if (allAssignedRecords.length > 0) {
        //     console.log('Sample First Record Structure Object:', JSON.stringify(allAssignedRecords[0], null, 2));
        // }
        // console.log('--- EMULATOR INBOUND QUICKBASE RESPONSE DATA ---');
        // console.log('============= QUICKBASE DATA RETRIEVED CLEANLY =============');
        // console.log('Total Raw rows returned from QB database:', allAssignedRecords.length);
        // console.log('Raw JSON Array Dump:', JSON.stringify(allAssignedRecords, null, 2));
        // console.log('[Schedule][QuickbaseResults]', {
        //     techId: normalizedTechId,
        //     assignmentWhere,
        //     serviceOrderWhere,
        //     totalRecords: allAssignedRecords.length
        // });
        // if (allAssignedRecords.length > 0) {
        //     console.log('[Schedule][EmailFieldSnapshot]', {
        //         techId: normalizedTechId,
        //         sample: allAssignedRecords.slice(0, 10).map((record) => ({
        //             recordId: getFieldValue(record, 3),
        //             phone: getFieldValue(record, 95),
        //             mobile: getFieldValue(record, 96),
        //             email: getFieldValue(record, 142)
        //         })),
        //         missingEmailCount: allAssignedRecords.filter((record) => !String(getFieldValue(record, 142) || '').trim()).length
        //     });
        // }

        const filteredRecords = allAssignedRecords
            .filter((record) => matchesScheduleDate(record, date))
            .sort((left, right) => getStopNumber(left) - getStopNumber(right));

        const recordsWithAssignmentStatus = filteredRecords.map((record) => {
            const soId = getFieldValue(record, 3);
            const assignmentKey = soId ? String(soId) : null;
            const hasAssignment = assignmentKey && assignmentStatusByServiceOrderId.has(assignmentKey);
            const techAssignmentStatus = hasAssignment
                ? assignmentStatusByServiceOrderId.get(assignmentKey)
                : undefined;
            return {
                ...record,
                _techAssignmentStatus: techAssignmentStatus,
            };
        });


        // console.log('[Schedule][PipelineSummary]', {
        //     techId: normalizedTechId,
        //     selectedDate: date,
        //     keptRecords: filteredRecords.length
        // });

        res.json(recordsWithAssignmentStatus);
    } catch (error) {
    //     console.error("Schedule Query Error:", error.response ? error.response.data : error.message);
    //     console.error('[Schedule][QuickbaseErrorDetails]', {
    //         message: error.message,
    //         status: error.response?.status || null,
    //         statusText: error.response?.statusText || null,
    //         headers: error.response?.headers || null,
    //         data: error.response?.data || null
    //     });

    //     const status = error?.response?.status;
    //     if (status === 401 || status === 403) {
    //         console.warn('[Schedule][GracefulUnauthorizedReturn]', {
    //             reason: 'assigned technicians query unauthorized',
    //             returning: 'empty schedule array'
    //         });
    //         return res.json([]);
    //     }

    //     res.status(500).send("Error retrieving schedule");
    }
});

// --- GET JOB DETAIL BY RECORD ID ---
app.post('/job-detail', async (req, res) => {
    const { recordId } = req.body || {};

    if (!recordId) {
        return res.status(400).json({ success: false, message: 'recordId is required' });
    }

    const normalizedRecordId = Number.parseInt(recordId, 10);
    if (!Number.isFinite(normalizedRecordId)) {
        return res.status(400).json({ success: false, message: 'recordId must be numeric' });
    }

    try {
        const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.SERVICE_ORDERS,
            select: [3, 6, 7, 9, 10, 11, 15, 16, 26, 40, 41, 44, 46, 153, 48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 59, 70, 71, 73, 90, 92, 93, 94, 105, 106, 107, 108, 110, 142],
            where: `{'3'.EX.'${normalizedRecordId}'}`
        }, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        const record = response?.data?.data?.[0] || null;
        if (!record) {
            return res.status(404).json({ success: false, message: 'Job not found' });
        }

        return res.json({ success: true, data: record });
    } catch (error) {
        console.error('Job Detail Query Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error retrieving job detail' });
    }
});

// --- GET SERVICE ORDER ASSIGNMENTS ---
app.post('/service-order/assignments', async (req, res) => {
    const { serviceOrderId } = req.body || {};

    if (!serviceOrderId) {
        return res.status(400).json({ success: false, message: 'serviceOrderId is required' });
    }

    const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
    if (!Number.isFinite(normalizedServiceOrderId)) {
        return res.status(400).json({ success: false, message: 'serviceOrderId must be numeric' });
    }

    try {
        const assignmentsResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.ASSIGNED_TECHNICIANS,
            select: [3, ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER, ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE, ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS],
            where: `{'${ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER}'.EX.'${normalizedServiceOrderId}'}`
        }, {
            headers: buildQuickbaseHeaders()
        });

        const assignmentRecords = Array.isArray(assignmentsResponse?.data?.data) ? assignmentsResponse.data.data : [];
        const employeeIds = Array.from(new Set(
            assignmentRecords
                .map((record) => Number.parseInt(getFieldValue(record, ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE), 10))
                .filter((id) => Number.isFinite(id))
        ));

        const employeeNamesById = new Map();
        if (employeeIds.length > 0) {
            const employeeWhere = employeeIds.map((id) => `{'3'.EX.${id}}`).join('OR');
            const employeeResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                from: TABLES.EMPLOYEES,
                select: [3, 6, 7],
                where: employeeWhere
            }, {
                headers: buildQuickbaseHeaders()
            });

            const employeeRecords = Array.isArray(employeeResponse?.data?.data) ? employeeResponse.data.data : [];
            for (const record of employeeRecords) {
                const id = Number.parseInt(getFieldValue(record, 3), 10);
                if (Number.isFinite(id)) {
                    const firstName = String(getFieldValue(record, 6) || '').trim();
                    const lastName = String(getFieldValue(record, 7) || '').trim();
                    employeeNamesById.set(String(id), `${firstName} ${lastName}`.trim() || `Technician ${id}`);
                }
            }
        }

        const data = assignmentRecords.map((record) => {
            const recordId = String(getFieldValue(record, 3) || '');
            const serviceOrderIdValue = String(getFieldValue(record, ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER) || '');
            const technicianId = String(getFieldValue(record, ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE) || '');
            const assignmentStatus = String(getFieldValue(record, ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS) || '').trim();
            const technicianName = employeeNamesById.get(technicianId) || `Technician ${technicianId}`;

            return {
                recordId,
                serviceOrderId: serviceOrderIdValue,
                technicianId,
                technicianName,
                assignmentStatus,
            };
        });

        return res.json({ success: true, data });
    } catch (error) {
        console.error('Service Order Assignments Query Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error retrieving service order assignments' });
    }
});

// --- GET OFFERED SERVICE ITEMS CATALOG ---
app.post('/estimate/offered-service-items', async (req, res) => {
    const { tableId } = req.body || {};
    const targetTableId = String(tableId || TABLES.OFFERED_SERVICE_ITEMS || '').trim();

    if (!targetTableId) {
        return res.status(500).json({
            success: false,
            message: 'Offered Service Items table is not configured. Set QB_OFFERED_SERVICE_ITEMS_TABLE in functions environment.'
        });
    }

    const OFFERED_SERVICE_ITEM_FIELDS = {
        SERVICE_CATEGORY: 7,
        OFFERED_SERVICE_ITEM: 11,
        TYPE_OF_SERVICE: 12,
        COST: 13,
        PAY_COST_UNIT: 14,
        SERVICE_DESCRIPTION: 27
    };

    const packageCategoryKeywords = ['budget', 'value', 'basic maintenance', 'package', 'tip-top roof care club'];
    const tierOrder = { good: 1, better: 2, best: 3 };

    const inferPackageTier = (typeOfService, itemName) => {
        const source = `${typeOfService || ''} ${itemName || ''}`.toLowerCase();
        if (source.includes('good')) {
            return 'Good';
        }
        if (source.includes('better')) {
            return 'Better';
        }
        if (source.includes('best')) {
            return 'Best';
        }
        return '';
    };

    const isPackageCategory = (categoryValue) => {
        const normalized = String(categoryValue || '').trim().toLowerCase();
        return packageCategoryKeywords.some((keyword) => normalized.includes(keyword));
    };

    try {
        const recordsResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: targetTableId,
            select: [
                3,
                OFFERED_SERVICE_ITEM_FIELDS.SERVICE_CATEGORY,
                OFFERED_SERVICE_ITEM_FIELDS.OFFERED_SERVICE_ITEM,
                OFFERED_SERVICE_ITEM_FIELDS.TYPE_OF_SERVICE,
                OFFERED_SERVICE_ITEM_FIELDS.COST,
                OFFERED_SERVICE_ITEM_FIELDS.PAY_COST_UNIT,
                OFFERED_SERVICE_ITEM_FIELDS.SERVICE_DESCRIPTION
            ]
        }, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        const rows = Array.isArray(recordsResponse?.data?.data) ? recordsResponse.data.data : [];
        const normalizedItems = rows.map((row) => {
            const category = String(row?.[String(OFFERED_SERVICE_ITEM_FIELDS.SERVICE_CATEGORY)]?.value || '').trim();
            const name = String(row?.[String(OFFERED_SERVICE_ITEM_FIELDS.OFFERED_SERVICE_ITEM)]?.value || '').trim();
            const typeOfService = String(row?.[String(OFFERED_SERVICE_ITEM_FIELDS.TYPE_OF_SERVICE)]?.value || '').trim();
            const unit = String(row?.[String(OFFERED_SERVICE_ITEM_FIELDS.PAY_COST_UNIT)]?.value || '').trim();
            const description = String(row?.[String(OFFERED_SERVICE_ITEM_FIELDS.SERVICE_DESCRIPTION)]?.value || '').trim();
            const packageTier = inferPackageTier(typeOfService, name);

            return {
                id: Number.parseInt(row?.['3']?.value, 10) || 0,
                category,
                name,
                serviceType: typeOfService,
                unit,
                description,
                price: parseNumericValue(row?.[String(OFFERED_SERVICE_ITEM_FIELDS.COST)]?.value),
                isPackage: isPackageCategory(category) || !!packageTier,
                packageTier,
                active: true,
                sortOrder: 0,
                raw: row
            };
        });

        const filteredItems = normalizedItems
            .filter((item) => !!item.name && item.active)
            .sort((left, right) => {
                const byCategory = left.category.localeCompare(right.category);
                if (byCategory !== 0) {
                    return byCategory;
                }

                const leftTier = tierOrder[String(left.packageTier || '').toLowerCase()] || 99;
                const rightTier = tierOrder[String(right.packageTier || '').toLowerCase()] || 99;
                if (leftTier !== rightTier) {
                    return leftTier - rightTier;
                }

                return left.name.localeCompare(right.name);
            });

        return res.json({ success: true, data: filteredItems });
    } catch (error) {
        console.error('Offered Service Items Query Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error retrieving offered service items' });
    }
});

// --- CREATE EMPLOYEE TIMECARD (CLOCK IN) ---
app.post('/timecard/clock-in', async (req, res) => {
    const { employeeId, date, clockInTime, clockInCoordinates } = req.body;

    if (!employeeId || !date || !clockInTime) {
        return res.status(400).json({ success: false, message: 'employeeId, date, and clockInTime are required' });
    }

    const normalizedEmployeeId = Number.parseInt(employeeId, 10);
    if (!Number.isFinite(normalizedEmployeeId)) {
        return res.status(400).json({ success: false, message: 'employeeId must be numeric' });
    }

    try {
        const payload = {
            to: TABLES.EMPLOYEE_TIMECARDS,
            data: [{
                [TIMECARD_FIELDS.RELATED_EMPLOYEE_NUMERIC]: { value: normalizedEmployeeId },
                [TIMECARD_FIELDS.DATE]: { value: date },
                [TIMECARD_FIELDS.CLOCK_IN_TIME]: { value: clockInTime },
                [TIMECARD_FIELDS.CLOCK_IN_COORDINATES]: { value: clockInCoordinates || '' }
            }],
            fieldsToReturn: [3]
        };

        const response = await axios.post(`${QB_API_ENDPOINT}/records`, payload, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        const recordId = response?.data?.metadata?.createdRecordIds?.[0]
            || response?.data?.data?.[0]?.['3']?.value;

        if (!recordId) {
            return res.status(500).json({ success: false, message: 'Quickbase did not return a timecard record ID' });
        }

        return res.json({ success: true, recordId: String(recordId) });
    } catch (error) {
        console.error('Clock In Timecard Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error creating timecard' });
    }
});

// --- UPDATE EMPLOYEE TIMECARD (CLOCK OUT) ---
app.post('/timecard/clock-out', async (req, res) => {
    const { recordId, clockOutTime, clockOutCoordinates } = req.body;

    if (!recordId || !clockOutTime) {
        return res.status(400).json({ success: false, message: 'recordId and clockOutTime are required' });
    }

    const normalizedRecordId = Number.parseInt(recordId, 10);
    if (!Number.isFinite(normalizedRecordId)) {
        return res.status(400).json({ success: false, message: 'recordId must be numeric' });
    }

    try {
        const payload = {
            to: TABLES.EMPLOYEE_TIMECARDS,
            data: [{
                3: { value: normalizedRecordId },
                [TIMECARD_FIELDS.CLOCK_OUT_TIME]: { value: clockOutTime },
                [TIMECARD_FIELDS.CLOCK_OUT_COORDINATES]: { value: clockOutCoordinates || '' }
            }],
            fieldsToReturn: [3]
        };

        await axios.post(`${QB_API_ENDPOINT}/records`, payload, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        return res.json({ success: true, recordId: String(normalizedRecordId) });
    } catch (error) {
        console.error('Clock Out Timecard Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error updating timecard' });
    }
});

// --- UPDATE TIMECARD JOB EVENT TIMESTAMP ---
app.post('/timecard/job-event', async (req, res) => {
    const { recordId, eventType, eventAt } = req.body || {};

    if (!recordId || !eventType) {
        return res.status(400).json({ success: false, message: 'recordId and eventType are required' });
    }

    const normalizedRecordId = Number.parseInt(recordId, 10);
    if (!Number.isFinite(normalizedRecordId)) {
        return res.status(400).json({ success: false, message: 'recordId must be numeric' });
    }

    const normalizedEventType = String(eventType).trim().toLowerCase();
    const eventFieldMap = {
        complete: TIMECARD_FIELDS.JOB_COMPLETE_AT,
        return_required: TIMECARD_FIELDS.JOB_RETURN_REQUIRED_AT
    };

    const targetFid = eventFieldMap[normalizedEventType];
    if (!targetFid) {
        return res.status(400).json({
            success: false,
            message: `No timecard field configured for event type: ${normalizedEventType}`
        });
    }

    const timestampValue = eventAt || new Date().toISOString();

    try {
        await axios.post(`${QB_API_ENDPOINT}/records`, {
            to: TABLES.EMPLOYEE_TIMECARDS,
            data: [{
                3: { value: normalizedRecordId },
                [targetFid]: { value: String(timestampValue) }
            }],
            fieldsToReturn: [3]
        }, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        return res.json({ success: true, recordId: String(normalizedRecordId), eventType: normalizedEventType });
    } catch (error) {
        console.error('Timecard Job Event Update Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error updating timecard job event' });
    }
});

// --- FETCH ACTIVE TIMECARD CHECK ---
app.post('/timecard/active', async (req, res) => {
    const { employeeId, date } = req.body;

    if (!employeeId || !date) {
        return res.status(400).json({ success: false, message: 'employeeId and date are required' });
    }

    const normalizedEmployeeId = Number.parseInt(employeeId, 10);

    try {
        console.log(`> [Timecard Proxy Route] Querying active shift for Tech ID: ${normalizedEmployeeId} on Date: ${date}`);

        // Query Quickbase Timecards table for an open record
        const queryPayload = {
            from: TABLES.EMPLOYEE_TIMECARDS,
            select: [3, TIMECARD_FIELDS.CLOCK_IN_TIME],
            where: `{'${TIMECARD_FIELDS.RELATED_EMPLOYEE_NUMERIC}'.EX.${normalizedEmployeeId}}AND{'${TIMECARD_FIELDS.DATE}'.EX.'${date}'}AND{'${TIMECARD_FIELDS.CLOCK_OUT_TIME}'.EX.''}`
        };

        const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, queryPayload, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        if (response?.data?.data?.length > 0) {
            const row = response.data.data[0];
            console.log(`> [Timecard Proxy Route] Found open record row ID: ${row['3'].value}`);
            
            console.log('> [Timecard Proxy Route] Returning shiftContext:', {
                employeeId: normalizedEmployeeId,
                date,
                isClockedIn: true,
                recordId: String(row['3'].value),
                clockInTime: row[TIMECARD_FIELDS.CLOCK_IN_TIME]?.value || ''
            });

            // Build the nested shiftContext layout object the front-end page is looking for!
            return res.json({
                success: true,
                shiftContext: {
                    isClockedIn: true,
                    recordId: String(row['3'].value),
                    clockInTime: row[TIMECARD_FIELDS.CLOCK_IN_TIME]?.value || ''
                }
            });
        }

        console.log(`> [Timecard Proxy Route] No open timecard records exist for today.`);

        console.log('> [Timecard Proxy Route] Returning shiftContext:', {
            employeeId: normalizedEmployeeId,
            date,
            isClockedIn: false,
            recordId: null
        });

        return res.json({ success: true, shiftContext: { isClockedIn: false, recordId: null } });
    } catch (error) {
        console.error('Active Timecard Route Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error checking active timecard status' });
    }
});

// --- UPDATE SERVICE ORDER WORKFLOW (STATUS + APPEND NOTE) ---
const handleServiceOrderWorkflowUpdate = async (req, res) => {
    const {
        recordId,
        serviceOrderId,
        status,
        noteToAppend,
        workflowEventType,
        workflowEventTimestamp,
        workflowGpsCoordinates,
        workflowNotes,
        relatedEmployeeId,
        techId,
        technicianName,
        technicianPhotoUrl,
        customerFirstName,
        customerMobile,
        technicianFirstName,
        jobAddress,
        jobLat,
        jobLng,
        taskId,
        taskStatus
    } = req.body || {};

    const effectiveServiceOrderId = serviceOrderId || recordId;
    if (!effectiveServiceOrderId) {
        return res.status(400).json({ success: false, message: 'recordId or serviceOrderId is required' });
    }

    if (!status && !noteToAppend && !workflowEventType) {
        return res.status(400).json({
            success: false,
            message: 'At least one of status, noteToAppend, or workflowEventType is required'
        });
    }

    const normalizedServiceOrderId = Number.parseInt(effectiveServiceOrderId, 10);
    if (!Number.isFinite(normalizedServiceOrderId)) {
        return res.status(400).json({ success: false, message: 'recordId/serviceOrderId must be numeric' });
    }

    const normalizedTechId = Number.parseInt(techId || relatedEmployeeId, 10);
    const normalizedAction = normalizeWorkflowAction(workflowEventType);
    // The UI sends 'Complete' as the workflowEventType for a job completion.
    // normalizeWorkflowAction() returns 'COMPLETE' for that, so trigger the
    // parent status patch when the action is COMPLETE (which should set
    // the parent Service Order status to 'Inspected').
    const shouldForceInspectionParentStatusPatch = normalizedAction === 'COMPLETE';
    const targetAssignmentStatus = ASSIGNMENT_STATUS_BY_ACTION[normalizedAction] || null;
    const shouldSkipAssignmentStatusUpdate = ACTIONS_WITHOUT_ASSIGNMENT_STATUS_UPDATE.has(normalizedAction);
    const shouldProcessAssignmentAction = !!targetAssignmentStatus || shouldSkipAssignmentStatusUpdate;
    let parentStatusSummary = null;
    let parentStatusPatchedTo = null;

    try {
        if (workflowEventType) {
            // --- TASK COMPLETE: update the child Task record directly ---
            // This avoids writing a workflow log with an unsupported event type and
            // keeps the parent Service Order status unchanged.
            if (normalizedAction === 'TASKCOMPLETE') {
                const normalizedTaskId = Number.parseInt(taskId, 10);
                if (!Number.isFinite(normalizedTaskId)) {
                    return res.status(400).json({ success: false, message: 'taskId is required and must be numeric for TaskComplete' });
                }
                const normalizedTaskStatus = String(taskStatus || '').trim();
                if (!normalizedTaskStatus) {
                    return res.status(400).json({ success: false, message: 'taskStatus is required for TaskComplete' });
                }

                await axios.post(`${QB_API_ENDPOINT}/records`, {
                    to: TABLES.SERVICE_ORDER_TASKS,
                    data: [{
                        3: { value: normalizedTaskId },
                        8: { value: normalizedTaskStatus }
                    }],
                    fieldsToReturn: [3, 8]
                }, {
                    headers: buildQuickbaseHeaders()
                });

                return res.json({
                    success: true,
                    recordId: String(normalizedTaskId),
                    taskStatus: normalizedTaskStatus
                });
            }

            if (shouldProcessAssignmentAction && !Number.isFinite(normalizedTechId)) {
                return res.status(400).json({
                    success: false,
                    message: 'techId or relatedEmployeeId is required and must be numeric for workflow actions'
                });
            }

            if (targetAssignmentStatus) {
                const assignmentLookupResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                    from: TABLES.ASSIGNED_TECHNICIANS,
                    select: [3, ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER, ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE, ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS],
                    where: `{'${ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE}'.EX.'${normalizedTechId}'}AND{'${ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER}'.EX.'${normalizedServiceOrderId}'}`
                }, {
                    headers: {
                        'QB-Realm-Hostname': QB_REALM_HOST,
                        'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                    }
                });

                const assignmentRecord = assignmentLookupResponse?.data?.data?.[0] || null;
                const assignmentRecordId = Number.parseInt(assignmentRecord?.['3']?.value, 10);
                if (!Number.isFinite(assignmentRecordId)) {
                    return res.status(404).json({
                        success: false,
                        message: `No Assigned Technicians row found for techId ${normalizedTechId} and serviceOrderId ${normalizedServiceOrderId}`
                    });
                }

                const assignmentUpdateResponse = await axios.post(`${QB_API_ENDPOINT}/records`, {
                    to: TABLES.ASSIGNED_TECHNICIANS,
                    data: [{
                        3: { value: assignmentRecordId },
                        [ASSIGNED_TECH_FIELDS.RELATED_SERVICE_ORDER]: { value: normalizedServiceOrderId },
                        [ASSIGNED_TECH_FIELDS.RELATED_EMPLOYEE]: { value: normalizedTechId },
                        [ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS]: { value: targetAssignmentStatus }
                    }],
                    fieldsToReturn: [
                        3,
                        ASSIGNED_TECH_FIELDS.ASSIGNMENT_STATUS,
                        SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS,
                        SERVICE_ORDER_STATUS_SYNC_FIELDS.TOTAL_TECHS_ASSIGNED,
                        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_DISPATCHED,
                        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_ARRIVED,
                        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_COMPLETED,
                        SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_RETURN_REQUIRED
                    ]
                }, {
                    headers: {
                        'QB-Realm-Hostname': QB_REALM_HOST,
                        'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                    }
                });

                const assignmentUpdatedRecord = assignmentUpdateResponse?.data?.data?.[0] || null;
                if (hasParentSummaryFields(assignmentUpdatedRecord)) {
                    parentStatusSummary = extractParentStatusSummaryFromChildRecord(assignmentUpdatedRecord);
                } else {
                    const parentSnapshotResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                        from: TABLES.SERVICE_ORDERS,
                        select: [
                            SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS,
                            SERVICE_ORDER_STATUS_SYNC_FIELDS.TOTAL_TECHS_ASSIGNED,
                            SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_DISPATCHED,
                            SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_ARRIVED,
                            SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_COMPLETED,
                            SERVICE_ORDER_STATUS_SYNC_FIELDS.CREWS_RETURN_REQUIRED
                        ],
                        where: `{'3'.EX.'${normalizedServiceOrderId}'}`
                    }, {
                        headers: {
                            'QB-Realm-Hostname': QB_REALM_HOST,
                            'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                        }
                    });

                    const parentSnapshotRecord = parentSnapshotResponse?.data?.data?.[0] || null;
                    parentStatusSummary = extractParentStatusSummaryFromChildRecord(parentSnapshotRecord);

                    console.log('[Workflow][ParentSyncSnapshot]', {
                        serviceOrderId: normalizedServiceOrderId,
                        techId: normalizedTechId,
                        action: normalizedAction,
                        source: 'PARENT_QUERY_FALLBACK',
                        reason: 'child write response missing summary field values',
                        summary: parentStatusSummary
                    });
                }

                const resolvedParentStatus = resolveParentStatusFromSummary(parentStatusSummary);
                const parentSyncRuleLabel = getParentSyncRuleLabel(parentStatusSummary, resolvedParentStatus);

                console.log('[Workflow][ParentSyncSnapshot]', {
                    serviceOrderId: normalizedServiceOrderId,
                    techId: normalizedTechId,
                    action: normalizedAction,
                    source: hasParentSummaryFields(assignmentUpdatedRecord) ? 'CHILD_WRITE_RETURN' : 'PARENT_QUERY_FALLBACK',
                    summary: parentStatusSummary
                });

                if (resolvedParentStatus) {
                    if (resolvedParentStatus !== parentStatusSummary?.parentStatus) {
                        console.log('[Workflow][ParentSyncAction]', {
                            serviceOrderId: normalizedServiceOrderId,
                            rule: parentSyncRuleLabel,
                            mode: 'PATCH_PARENT_STATUS',
                            fromStatus: parentStatusSummary?.parentStatus || '',
                            toStatus: resolvedParentStatus
                        });

                        await axios.post(`${QB_API_ENDPOINT}/records`, {
                            to: TABLES.SERVICE_ORDERS,
                            data: [{
                                3: { value: normalizedServiceOrderId },
                                [SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS]: { value: resolvedParentStatus }
                            }],
                            fieldsToReturn: [3, SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS]
                        }, {
                            headers: {
                                'QB-Realm-Hostname': QB_REALM_HOST,
                                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                            }
                        });
                    } else {
                        console.log('[Workflow][ParentSyncAction]', {
                            serviceOrderId: normalizedServiceOrderId,
                            rule: parentSyncRuleLabel,
                            mode: 'NO_PATCH_ALREADY_IN_TARGET_STATUS',
                            currentStatus: parentStatusSummary?.parentStatus || ''
                        });
                    }

                    parentStatusPatchedTo = resolvedParentStatus;
                } else {
                    console.log('[Workflow][ParentSyncAction]', {
                        serviceOrderId: normalizedServiceOrderId,
                        action: normalizedAction,
                        mode: 'MIXED_STATE_SAFE_EXIT_NO_PARENT_PATCH',
                        summary: parentStatusSummary
                    });
                }
            }

            const workflowLogResult = await createWorkflowLogRecord({
                eventType: workflowEventType,
                eventTimestamp: new Date().toISOString(),
                gpsCoordinates: workflowGpsCoordinates,
                notes: workflowNotes,
                relatedServiceOrder: normalizedServiceOrderId,
                relatedEmployee: normalizedTechId
            });

            // --- DISPATCH SMS (fire-and-forget) ---
            if (normalizedAction === 'DISPATCH') {
                const workflowLogRecordId = Number.parseInt(workflowLogResult?.data?.[0]?.['3']?.value, 10);
                const originalNotes = String(workflowNotes || '').trim();

                (async () => {
                    try {
                        const resolvedCustomerMobile = String(customerMobile || '').trim();
                        const resolvedCustomerFirstName = String(customerFirstName || '').trim() || 'Valued Customer';

                        if (!resolvedCustomerMobile) {
                            console.warn('[DispatchSMS] No customer mobile provided, skipping SMS.', { serviceOrderId: normalizedServiceOrderId });
                            await patchWorkflowLog(workflowLogRecordId, {
                                [WORKFLOW_LOG_FIELDS.SMS_STATUS]: { value: 'Skipped' },
                                [WORKFLOW_LOG_FIELDS.NOTES]: { value: [originalNotes, 'SMS skipped. No customer mobile number.'].filter(Boolean).join(' ').trim() }
                            });
                            return;
                        }

                        const resolvedTechFirstName = String(technicianFirstName || '').trim() || 'Your technician';

                        // --- ETA calculation (non-blocking) ---
                        const { etaMinutes, diagnostic: etaDiagnostic } = await getEtaMinutes(
                            workflowGpsCoordinates,
                            { destLat: jobLat, destLng: jobLng, destAddress: String(jobAddress || '').trim() }
                        );

                        const etaPhrase = Number.isFinite(etaMinutes) && etaMinutes > 0
                            ? ` and should arrive in approximately ${etaMinutes} minute${etaMinutes === 1 ? '' : 's'}`
                            : '';

                        const smsText = `Hi ${resolvedCustomerFirstName}, we're letting you know that ${resolvedTechFirstName} with The Roof Medic is on the way${etaPhrase}. We look forward to serving you today! If you have any questions, please call 253-862-4412.`;

                        const credentials = {
                            clientId: rcClientId.value(),
                            clientSecret: rcClientSecret.value(),
                            jwt: rcJwt.value()
                        };

                        const result = await sendSms(credentials, resolvedCustomerMobile, smsText);

                        console.log('[DispatchSMS] SMS sent successfully', {
                            serviceOrderId: normalizedServiceOrderId,
                            to: resolvedCustomerMobile,
                            etaMinutes,
                            messageId: result.messageId,
                            messageStatus: result.messageStatus
                        });

                        const etaLogNote = etaMinutes !== null
                            ? `ETA calculated: ${etaMinutes} minute${etaMinutes === 1 ? '' : 's'}.`
                            : `ETA unavailable: ${etaDiagnostic}`;

                        await patchWorkflowLog(workflowLogRecordId, {
                            [WORKFLOW_LOG_FIELDS.SMS_STATUS]: { value: 'Sent' },
                            [WORKFLOW_LOG_FIELDS.NOTES]: { value: [originalNotes, 'SMS sent successfully.', etaLogNote, `RingCentral Message ID: ${result.messageId}.`].filter(Boolean).join(' ').trim() }
                        });
                    } catch (smsErr) {
                        console.error('[DispatchSMS] Failed to send SMS, dispatch workflow unaffected', {
                            serviceOrderId: normalizedServiceOrderId,
                            message: smsErr.message
                        });
                        try {
                            await patchWorkflowLog(workflowLogRecordId, {
                                [WORKFLOW_LOG_FIELDS.SMS_STATUS]: { value: 'Failed' },
                                [WORKFLOW_LOG_FIELDS.NOTES]: { value: [originalNotes, `SMS failed. ${smsErr.message}`].filter(Boolean).join(' ').trim() }
                            });
                        } catch (patchErr) {
                            console.error('[DispatchSMS] Also failed to patch workflow log with SMS failure', { message: patchErr.message });
                        }
                    }
                })();
            }

            // --- ARRIVE SMS (fire-and-forget) ---
            if (normalizedAction === 'ARRIVED') {
                const arriveWorkflowLogRecordId = Number.parseInt(workflowLogResult?.data?.[0]?.['3']?.value, 10);
                const arriveOriginalNotes = String(workflowNotes || '').trim();

                (async () => {
                    try {
                        const resolvedCustomerMobile = String(customerMobile || '').trim();
                        const resolvedCustomerFirstName = String(customerFirstName || '').trim() || 'Valued Customer';

                        if (!resolvedCustomerMobile) {
                            console.warn('[ArrivalSMS] No customer mobile provided, skipping SMS.', { serviceOrderId: normalizedServiceOrderId });
                            await patchWorkflowLog(arriveWorkflowLogRecordId, {
                                [WORKFLOW_LOG_FIELDS.SMS_STATUS]: { value: 'Skipped' },
                                [WORKFLOW_LOG_FIELDS.NOTES]: { value: [arriveOriginalNotes, 'SMS skipped. No customer mobile number.'].filter(Boolean).join(' ').trim() }
                            });
                            return;
                        }

                        const resolvedTechFirstName = String(technicianFirstName || '').trim() || 'Your technician';
                        const smsText = `Hi ${resolvedCustomerFirstName}, we're letting you know that ${resolvedTechFirstName} with The Roof Medic has arrived for your scheduled appointment and is ready to begin. If you have any questions, please call 253-862-4412.`;

                        const credentials = {
                            clientId: rcClientId.value(),
                            clientSecret: rcClientSecret.value(),
                            jwt: rcJwt.value()
                        };

                        const result = await sendSms(credentials, resolvedCustomerMobile, smsText);

                        console.log('[ArrivalSMS] SMS sent successfully', {
                            serviceOrderId: normalizedServiceOrderId,
                            to: resolvedCustomerMobile,
                            messageId: result.messageId
                        });

                        await patchWorkflowLog(arriveWorkflowLogRecordId, {
                            [WORKFLOW_LOG_FIELDS.SMS_STATUS]: { value: 'Sent' },
                            [WORKFLOW_LOG_FIELDS.NOTES]: { value: [arriveOriginalNotes, `SMS sent successfully. RingCentral Message ID: ${result.messageId}.`].filter(Boolean).join(' ').trim() }
                        });
                    } catch (smsErr) {
                        console.error('[ArrivalSMS] Failed to send SMS, arrive workflow unaffected', {
                            serviceOrderId: normalizedServiceOrderId,
                            message: smsErr.message
                        });
                        try {
                            await patchWorkflowLog(arriveWorkflowLogRecordId, {
                                [WORKFLOW_LOG_FIELDS.SMS_STATUS]: { value: 'Failed' },
                                [WORKFLOW_LOG_FIELDS.NOTES]: { value: [arriveOriginalNotes, `SMS failed. ${smsErr.message}`].filter(Boolean).join(' ').trim() }
                            });
                        } catch (patchErr) {
                            console.error('[ArrivalSMS] Also failed to patch workflow log with SMS failure', { message: patchErr.message });
                        }
                    }
                })();
            }

            // --- ARRIVAL EMAIL (fire-and-forget) ---
            if (normalizedAction === 'ARRIVED') {
                (async () => {
                    try {
                        console.log('[ArrivalEmail] Querying service order for customer info...', { serviceOrderId: normalizedServiceOrderId });
                        const soResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                            from: TABLES.SERVICE_ORDERS,
                            select: [3, 93, 142],
                            where: `{'3'.EX.'${normalizedServiceOrderId}'}`
                        }, {
                            headers: buildQuickbaseHeaders()
                        });

                        const soRecord = soResponse?.data?.data?.[0] || null;
                        const customerFirstName = String(soRecord?.['93']?.value || '').trim();
                        const customerEmail = String(soRecord?.['142']?.value || '').trim();

                        if (!customerEmail) {
                            console.warn('[ArrivalEmail] No customer email on service order, skipping.', { serviceOrderId: normalizedServiceOrderId });
                            return;
                        }

                        const safeTechnicianName = String(technicianName || '').trim() || 'Your Technician';

                        // Download employee photo from QuickBase Files API (same pattern as inspection photos)
                        let techPhotoHtml = '';
                        const emailAttachments = [];
                        if (Number.isFinite(normalizedTechId)) {
                            try {
                                // Query employee record to verify FID 66 has a file
                                const empResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                                    from: TABLES.EMPLOYEES,
                                    select: [3, 66],
                                    where: `{'3'.EX.'${normalizedTechId}'}`
                                }, {
                                    headers: buildQuickbaseHeaders()
                                });

                                const empRecord = empResponse?.data?.data?.[0] || null;
                                const fileRef = empRecord?.['66']?.value;

                                if (fileRef && fileRef.url) {
                                    const fileUrl = `${QB_API_ENDPOINT}/files/${TABLES.EMPLOYEES}/${normalizedTechId}/66/1`;
                                    console.log('[ArrivalEmail] Downloading employee photo...', { fileUrl, techId: normalizedTechId });
                                    const fileResponse = await axios.get(fileUrl, {
                                        headers: buildQuickbaseHeaders(),
                                        responseType: 'arraybuffer'
                                    });

                                    const buffer = Buffer.from(fileResponse.data);
                                    const base64String = buffer.toString('utf-8').trim();

                                    const fileName = fileRef.versions?.[0]?.fileName || '';
                                    const extension = fileName.split('.').pop()?.toLowerCase() || '';
                                    let mimeType = 'image/png';
                                    if (base64String.startsWith('/9j/') || extension === 'jpg' || extension === 'jpeg') {
                                        mimeType = 'image/jpeg';
                                    }

                                    emailAttachments.push({
                                        filename: fileName || 'technician-photo.jpg',
                                        content: base64String,
                                        encoding: 'base64',
                                        cid: 'technicianPhoto'
                                    });

                                    techPhotoHtml = `<div style="text-align: center; margin-bottom: 10px;"><img src="cid:technicianPhoto" alt="${safeTechnicianName}" style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover;" /></div>`;
                                    console.log('[ArrivalEmail] Employee photo attached as CID inline image');
                                } else {
                                    console.warn('[ArrivalEmail] No photo file on employee record, skipping photo.', { techId: normalizedTechId });
                                }
                            } catch (photoErr) {
                                console.error('[ArrivalEmail] Failed to download employee photo:', photoErr.message);
                            }
                        }

                        const arrivalTransporter = nodemailer.createTransport({
                            host: 'smtp.ionos.com',
                            port: 465,
                            secure: true,
                            auth: {
                                user: process.env.EMAIL_USER,
                                pass: process.env.EMAIL_PASS
                            }
                        });

                        const arrivalMailOptions = {
                            from: '"The Roof Medic" <' + process.env.EMAIL_USER + '>',
                            to: customerEmail,
                            subject: 'Your Roof Medic Technician Has Arrived',
                            html: `
                                <p>Dear ${customerFirstName || 'Valued Customer'},</p>

                                <p>Your Roof Medic technician has arrived and is beginning today's scheduled service.</p>

                                <p><strong>Meet Your Technician</strong></p>

                                ${techPhotoHtml}

                                <p style="text-align: center; font-size: 16px; font-weight: bold;">${safeTechnicianName}</p>

                                <p>Our goal is to provide exceptional service while treating your home with the same care and respect we'd give our own.</p>

                                <p>If you have any questions during today's visit, simply reply to this email or contact our office.</p>

                                <p>Thank you for choosing The Roof Medic. We appreciate the opportunity to serve you.</p>

                                <p>Sincerely,</p>

                                <p><strong>The Roof Medic</strong><br>
                                253-862-4412<br>
                                contact@yourroofmedic.com</p>
                            `,
                            attachments: emailAttachments
                        };

                        await arrivalTransporter.sendMail(arrivalMailOptions);
                        console.log('[ArrivalEmail] Email dispatched successfully to', customerEmail);
                    } catch (emailErr) {
                        console.error('[ArrivalEmail] Failed to send arrival email:', emailErr.message);
                    }
                })();
            }

            if (shouldForceInspectionParentStatusPatch) {
                await axios.post(`${QB_API_ENDPOINT}/records`, {
                    to: TABLES.SERVICE_ORDERS,
                    data: [{
                        3: { value: normalizedServiceOrderId },
                        [SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS]: { value: 'Inspected' }
                    }],
                    fieldsToReturn: [3, SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS]
                }, {
                    headers: {
                        'QB-Realm-Hostname': QB_REALM_HOST,
                        'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                    }
                });

                parentStatusPatchedTo = 'Inspected';
            }
        }

        if (status) {
            await axios.post(`${QB_API_ENDPOINT}/records`, {
                to: TABLES.SERVICE_ORDERS,
                data: [{
                    3: { value: normalizedServiceOrderId },
                    [SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS]: { value: String(status) }
                }],
                fieldsToReturn: [3, SERVICE_ORDER_STATUS_SYNC_FIELDS.PARENT_STATUS]
            }, {
                headers: {
                    'QB-Realm-Hostname': QB_REALM_HOST,
                    'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                }
            });

            parentStatusPatchedTo = String(status);
        }

        return res.json({
            success: true,
            recordId: String(normalizedServiceOrderId),
            parentStatusSummary,
            parentStatusPatchedTo
        });
    } catch (error) {
        console.error('Service Order Workflow Update Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error updating service order workflow' });
    }
};

app.post('/service-order/update-workflow', handleServiceOrderWorkflowUpdate);
app.post('/api/update-status', handleServiceOrderWorkflowUpdate);

    const handleSubmitInspectionData = async (req, res) => {
        console.log('BACKEND RAW INSPECTION INGESTION PACKET:', JSON.stringify(req.body));

        const inboundBody = req.body && typeof req.body === 'object' ? req.body : {};
            console.log('[Inspection][InboundBodyShape]', {
                hasMasterJobRecordValues: !!inboundBody.masterJobRecordValues,
                hasPhotoState: !!inboundBody.inspectionPhotoState,
                hasWorkflowFields: !!inboundBody.workflowEventType
            });

            // Removed ad-hoc workflow record writer to ensure all workflow logs are created
            // via createWorkflowLogRecord which enforces field mappings and logs responses.

            const {
                serviceOrderId,
                masterJobRecordValues,
                photoBatchData
            } = req.body || {};

            if (!serviceOrderId) {
                return res.status(400).json({ success: false, message: 'serviceOrderId is required' });
            }

            const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
            if (!Number.isFinite(normalizedServiceOrderId)) {
                return res.status(400).json({ success: false, message: 'serviceOrderId must be numeric' });
            }

            const masterFieldIds = [48, 49, 50, 153, 51, 52, 56, 57, 55, 53, 59, 58, 118, 120, 121, 122, 123, 124, 125, 126, 10];
            const normalizedMasterValues = masterJobRecordValues && typeof masterJobRecordValues === 'object'
                ? masterJobRecordValues
                : {};
            console.log('--- DEBUG: Checking incoming masterJobRecordValues keys ---');
            console.log(Object.keys(normalizedMasterValues));

            const normalizeIncomingBase64String = (value) => {
                const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '');
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
                if (commaIndex !== -1 && normalized.slice(0, commaIndex).toLowerCase().includes('base64')) {
                    return normalized.slice(commaIndex + 1).replace(/\s+/g, '');
                }

                return normalized.replace(/\s+/g, '');
            };

            const toBase64FromByteArray = (bytes) => {
                if (!Array.isArray(bytes) || bytes.length === 0) {
                    return '';
                }

                try {
                    return Buffer.from(bytes.map((item) => Number(item) & 0xff)).toString('base64');
                } catch {
                    return '';
                }
            };

            const extractIncomingPhotoBase64 = (photoRow) => {
                const queue = [photoRow?.fid_8, photoRow];
                const seen = new Set();

                while (queue.length > 0) {
                    const candidate = queue.shift();
                    if (candidate === null || candidate === undefined) {
                        continue;
                    }

                    if (typeof candidate === 'string') {
                        const fromString = normalizeIncomingBase64String(candidate);
                        if (fromString) {
                            return fromString;
                        }
                        continue;
                    }

                    if (Array.isArray(candidate)) {
                        const isNumericArray = candidate.every((item) => Number.isFinite(Number(item)));
                        if (isNumericArray) {
                            const fromNumericArray = toBase64FromByteArray(candidate);
                            if (fromNumericArray) {
                                return fromNumericArray;
                            }
                        }

                        for (const nested of candidate) {
                            queue.push(nested);
                        }
                        continue;
                    }

                    if (typeof candidate !== 'object') {
                        continue;
                    }

                    if (seen.has(candidate)) {
                        continue;
                    }
                    seen.add(candidate);

                    if (candidate.type === 'Buffer' && Array.isArray(candidate.data)) {
                        const fromBuffer = toBase64FromByteArray(candidate.data);
                        if (fromBuffer) {
                            return fromBuffer;
                        }
                    }

                    if (Array.isArray(candidate.data)) {
                        const fromDataArray = toBase64FromByteArray(candidate.data);
                        if (fromDataArray) {
                            return fromDataArray;
                        }
                    }

                    queue.push(
                        candidate.value,
                        candidate.dataUrl,
                        candidate.base64,
                        candidate.base64Data,
                        candidate.imageBase64,
                        candidate.photoBase64,
                        candidate.fid_8,
                        candidate.data,
                        candidate.buffer,
                        candidate.file,
                        candidate.blob
                    );
                }

                return '';
            };

            const resolvedFieldMap = {
                SECTION: 6,
                NOTES: 7,
                FILE_ATTACHMENT: 8,
                RELATED_SERVICE_ORDER: 9
            };

            try {
                const serviceOrderRecordWrite = {
                    3: { value: normalizedServiceOrderId }
                };

                // DYNAMIC MAPPING: Take every key from the frontend and map it
                Object.keys(normalizedMasterValues).forEach(fid => {
                    const val = normalizedMasterValues[fid];
                    // Only map if it's a valid number (Field ID) and the value isn't null/undefined
                    if (!isNaN(Number(fid)) && val !== null && val !== undefined) {
                        serviceOrderRecordWrite[fid] = { value: val };
                    }
                });

                console.log('FINAL DYNAMIC QUICKBASE PAYLOAD:', JSON.stringify({ 
                    to: TABLES.SERVICE_ORDERS, 
                    data: [serviceOrderRecordWrite] 
                }));
                
                // Add this right before the axios.post call
                console.log('--- FINAL PAYLOAD SENT TO QUICKBASE ---', JSON.stringify({
                    to: TABLES.SERVICE_ORDERS,
                    data: [serviceOrderRecordWrite]
                }, null, 2));

                await axios.post(`${QB_API_ENDPOINT}/records`, {
                    to: TABLES.SERVICE_ORDERS,
                    data: [serviceOrderRecordWrite],
                    fieldsToReturn: [3, ...masterFieldIds]
                }, {
                    headers: {
                        'QB-Realm-Hostname': QB_REALM_HOST,
                        'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                    }
                });

                const incomingPhotoRows = Array.isArray(photoBatchData?.rows) ? photoBatchData.rows : [];
                const targetPhotoTableId = (photoBatchData?.tableId || TABLES.JOB_PHOTOS || '').toString().trim() || TABLES.JOB_PHOTOS;
                console.log('[Inspection][PhotoFieldMap][Resolved]', JSON.stringify({
                    tableId: targetPhotoTableId,
                    resolvedMap: resolvedFieldMap,
                    source: 'STATIC_BV3MP7TRA_FIELD_MAP'
                }));
                let insertedPhotoCount = 0;

                if (incomingPhotoRows.length > 0) {
                    const photoWriteRows = [];

                    for (let index = 0; index < incomingPhotoRows.length; index += 1) {
                        const photoRow = incomingPhotoRows[index];
                        const row = photoRow && typeof photoRow === 'object' ? photoRow : {};

                        try {
                            console.log('[Inspection][RawRowKeys]', Object.keys(row));

                            console.log('[Inspection][PhotoRow][PreFormat]', {
                                index,
                                rowType: Array.isArray(photoRow) ? 'array' : typeof photoRow,
                                rowKeys: Object.keys(photoRow || {}),
                                fid8Type: Array.isArray(photoRow?.fid_8) ? 'array' : typeof photoRow?.fid_8,
                                fid8Keys: photoRow?.fid_8 && typeof photoRow.fid_8 === 'object' ? Object.keys(photoRow.fid_8) : []
                            });

                            const relatedServiceOrderValue = normalizedServiceOrderId;

                            // row.fid_8 is the canonical mobile payload source for Quickbase file field content.
                            const normalizedPhotoBase64 = normalizeIncomingBase64String(row?.fid_8 || '');

                            const sectionValue = (row?.fid_6 || '').toString();
                            const notesValue = (row?.fid_7 || '').toString();
                            const quickbaseAttachmentValue = {
                                fileName: `inspection-${normalizedServiceOrderId}-${index + 1}.png`,
                                data: normalizedPhotoBase64
                            };

                            console.log('[Inspection][PhotoRow][AttachmentValueShape]', {
                                index,
                                attachmentKeys: Object.keys(quickbaseAttachmentValue),
                                fileName: quickbaseAttachmentValue.fileName,
                                dataLength: quickbaseAttachmentValue.data.length,
                                dataPreview: quickbaseAttachmentValue.data.slice(0, 48)
                            });

                            const payloadRow = {
                                [resolvedFieldMap.SECTION]: { value: sectionValue },
                                [resolvedFieldMap.NOTES]: { value: notesValue },
                                [resolvedFieldMap.FILE_ATTACHMENT]: {
                                    value: quickbaseAttachmentValue
                                },
                                [resolvedFieldMap.RELATED_SERVICE_ORDER]: { value: relatedServiceOrderValue }
                            };

                            console.log('[Inspection][PhotoRow][QuickbasePayloadStructure]', {
                                index,
                                payloadRow,
                                resolvedFieldMap,
                                base64Source: 'row.fid_8',
                                relatedServiceOrderValue,
                                base64Length: normalizedPhotoBase64.length,
                                base64Preview: normalizedPhotoBase64.slice(0, 48)
                            });

                            photoWriteRows.push(payloadRow);
                        } catch (photoRowError) {
                            console.error('[Inspection][PhotoRow][FormatError]', {
                                index,
                                rowKeys: Object.keys(photoRow || {}),
                                message: photoRowError?.message,
                                stack: photoRowError?.stack
                            });
                        }
                    }

                    // if (photoWriteRows.length === 0) {
                    //     console.warn('[Inspection][PhotoRow] No valid rows were generated after formatting attempt.', {
                    //         incomingPhotoCount: incomingPhotoRows.length
                    //     });
                    // }

                    const quickbasePhotoPayload = {
                        to: targetPhotoTableId,
                        data: photoWriteRows,
                        fieldsToReturn: [3]
                    };

                    // console.log('[Inspection][QuickbaseAttachmentBatch][PreSend]', {
                    //     tableId: targetPhotoTableId,
                    //     rowCount: photoWriteRows.length,
                    //     payload: quickbasePhotoPayload,
                    //     payloadStringified: JSON.stringify(quickbasePhotoPayload)
                    // });

                    let photoInsertResponse;
                    const quickbaseAttachmentRequestHeaders = {
                        'QB-Realm-Hostname': QB_REALM_HOST,
                        'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                    };

                    // console.log('[Inspection][QuickbaseAttachmentBatch][RequestConfig]', JSON.stringify({
                    //     endpoint: `${QB_API_ENDPOINT}/records`,
                    //     headers: quickbaseAttachmentRequestHeaders
                    // }, null, 2));

                    try {
                        photoInsertResponse = await axios.post(`${QB_API_ENDPOINT}/records`, quickbasePhotoPayload, {
                            headers: quickbaseAttachmentRequestHeaders
                        });
                    } catch (photoInsertError) {
                        // console.error('[Inspection][QuickbaseAttachmentBatch][AxiosError]', {
                        //     status: photoInsertError?.response?.status,
                        //     responseData: photoInsertError?.response?.data,
                        //     message: photoInsertError?.message,
                        //     stack: photoInsertError?.stack
                        // });
                        // console.error('[Inspection][QuickbaseAttachmentBatch][AxiosError][JSON]', JSON.stringify({
                        //     status: photoInsertError?.response?.status,
                        //     responseData: photoInsertError?.response?.data,
                        //     message: photoInsertError?.message,
                        //     stack: photoInsertError?.stack
                        // }));

                        const rawResponsePayloadPretty = JSON.stringify(photoInsertError?.response?.data, null, 2);
                        // console.error('[Inspection][QuickbaseAttachmentBatch][AxiosError][ResponseDataPretty]', rawResponsePayloadPretty);

                        const normalizedErrorText = String(rawResponsePayloadPretty || '').toLowerCase();
                        const quickbaseSignalFlags = {
                            hasNotAllowed: normalizedErrorText.includes('not allowed'),
                            hasInvalidUserToken: normalizedErrorText.includes('invalid user token'),
                            hasPermissionOrRoleException:
                                normalizedErrorText.includes('permission')
                                || normalizedErrorText.includes('role')
                                || normalizedErrorText.includes('schema')
                        };

                        if (quickbaseSignalFlags.hasNotAllowed || quickbaseSignalFlags.hasInvalidUserToken || quickbaseSignalFlags.hasPermissionOrRoleException) {
                            // console.error('[Inspection][QuickbaseAttachmentBatch][DetectedQuickbasePermissionSignals]', JSON.stringify({
                            //     flags: quickbaseSignalFlags,
                            //     responseData: photoInsertError?.response?.data
                            // }, null, 2));
                        }

                        if (!photoInsertError?.response) {
                            // console.error('[Inspection][QuickbaseAttachmentBatch][NoServerResponse][RequestHeaders]', JSON.stringify(quickbaseAttachmentRequestHeaders, null, 2));
                            // console.error('[Inspection][QuickbaseAttachmentBatch][NoServerResponse][AxiosConfigHeaders]', JSON.stringify(photoInsertError?.config?.headers || null, null, 2));
                        }

                        throw photoInsertError;
                    }

                    const responseStatus = Number(photoInsertResponse?.status);
                    const lineErrors = Array.isArray(photoInsertResponse?.data?.metadata?.lineErrors)
                        ? photoInsertResponse.data.metadata.lineErrors
                        : [];

                    if (responseStatus === 207 || lineErrors.length > 0) {
                        // console.error('[Inspection][QuickbaseAttachmentBatch][MultiStatusOrLineErrors]', {
                        //     status: responseStatus,
                        //     lineErrors,
                        //     responseData: photoInsertResponse?.data
                        // });
                        // console.error('[Inspection][QuickbaseAttachmentBatch][MultiStatusOrLineErrors][JSON]', JSON.stringify({
                        //     status: responseStatus,
                        //     lineErrors,
                        //     responseData: photoInsertResponse?.data
                        // }));
                        throw new Error('Quickbase returned multi-status or line errors for photo attachments.');
                    }

                    insertedPhotoCount = Array.isArray(photoInsertResponse?.data?.data)
                        ? photoInsertResponse.data.data.length
                        : photoWriteRows.length;
                }

                // Attempt to create a workflow log record if the caller supplied workflow fields.
                try {
                    const wfType = String(req.body?.workflowEventType || req.body?.eventType || '').trim();
                    const wfTimestamp = req.body?.workflowEventTimestamp || req.body?.eventTimestamp || new Date().toISOString();
                    const wfGps = req.body?.workflowGpsCoordinates || req.body?.gpsCoordinates || '';
                    const wfNotes = String(req.body?.workflowNotes || req.body?.notes || '');
                    const wfEmployee = req.body?.relatedEmployeeId || req.body?.techId || null;

                    if (wfType) {
                        try {
                            await createWorkflowLogRecord({
                                eventType: wfType,
                                eventTimestamp: wfTimestamp,
                                gpsCoordinates: wfGps,
                                notes: wfNotes,
                                relatedServiceOrder: normalizedServiceOrderId,
                                relatedEmployee: wfEmployee
                            });

                            console.log('[Inspection][WorkflowLog][Created]', {
                                serviceOrderId: normalizedServiceOrderId,
                                eventType: wfType,
                                relatedEmployee: wfEmployee
                            });
                        } catch (innerErr) {
                            console.warn('[Inspection][WorkflowLog][CreateFailed]', {
                                message: innerErr?.message || String(innerErr),
                                stack: innerErr?.stack || null
                            });
                        }
                    }
                } catch (err) {
                    console.error('[Inspection][WorkflowLog][PrepareFailed]', err?.message || String(err));
                }

                return res.json({
                    success: true,
                    recordId: String(normalizedServiceOrderId),
                    updatedFieldCount: Object.keys(serviceOrderRecordWrite).length - 1,
                    insertedPhotoCount
                });
            } catch (error) {
                console.error('[Inspection][Submit][UnhandledError]', {
                    status: error?.response?.status,
                    responseData: error?.response?.data,
                    message: error?.message,
                    stack: error?.stack
                });
                console.error('[Inspection][Submit][UnhandledError][JSON]', JSON.stringify({
                    status: error?.response?.status,
                    responseData: error?.response?.data,
                    message: error?.message,
                    stack: error?.stack
                }));
                return res.status(500).json({ success: false, message: 'Error submitting inspection data' });
            }
        };

    app.post('/submit-inspection-data', handleSubmitInspectionData);
    app.post('/api/submit-inspection-data', handleSubmitInspectionData);
    app.post('/inspections/submit', handleSubmitInspectionData);
    app.post('/estimate/submit', handleSubmitEstimateData);

    app.get('/estimate/retrieve/:serviceOrderId', async (req, res) => {
        const { serviceOrderId } = req.params;
        const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);

        if (!Number.isFinite(normalizedServiceOrderId)) {
            return res.status(400).json({ success: false, message: 'Invalid serviceOrderId' });
        }

        console.log('[EstimateRetrieve] Retrieving estimate data', { serviceOrderId: normalizedServiceOrderId });

        try {
            // Query SERVICE_ORDERS
            const serviceOrderResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                from: TABLES.SERVICE_ORDERS,
                select: [3, 11, 40, 66, 67, 69, 73, 83, 137, 154, 155, 93, 94, 95, 106, 92, 105, 142, 57],
                where: `{'3'.EX.${normalizedServiceOrderId}}`
            }, {
                headers: buildQuickbaseHeaders()
            });

            const serviceOrderRecords = Array.isArray(serviceOrderResponse?.data?.data)
                ? serviceOrderResponse.data.data
                : [];

            if (serviceOrderRecords.length === 0) {
                return res.status(404).json({ success: false, message: 'Service order not found' });
            }

            const serviceOrder = serviceOrderRecords[0];

            // Query ESTIMATE_LINE_ITEMS
            const lineItemsResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                from: TABLES.ESTIMATE_LINE_ITEMS,
                select: [3, 13, 16, 17, 18, 19, 20, 23, 24, 29],
                where: `{'13'.EX.${normalizedServiceOrderId}}`
            }, {
                headers: buildQuickbaseHeaders()
            });

            const lineItems = Array.isArray(lineItemsResponse?.data?.data)
                ? lineItemsResponse.data.data
                : [];

            // Query SERVICE_ORDER_ROOFS
            const serviceOrderRoofsResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                from: TABLES.SERVICE_ORDER_ROOFS,
                select: [3, 22, 24],
                where: `{'24'.EX.${normalizedServiceOrderId}}`
            }, {
                headers: buildQuickbaseHeaders()
            });

            const serviceOrderRoofs = Array.isArray(serviceOrderRoofsResponse?.data?.data)
                ? serviceOrderRoofsResponse.data.data
                : [];

            // Extract roof record IDs
            const roofRecordIds = serviceOrderRoofs
                .map(record => Number(record['22']?.value))
                .filter(id => Number.isFinite(id));

            // Query ROOFS for details
            let roofs = [];
            if (roofRecordIds.length > 0) {
                const roofsWhereClause = roofRecordIds.length === 1
                    ? `{'3'.EX.${roofRecordIds[0]}}`
                    : `(${roofRecordIds.map(id => `{'3'.EX.${id}}`).join('OR')})`;

                const roofsResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                    from: TABLES.ROOFS,
                    select: [3, 7, 59, 60, 61, 63, 64, 65, 66, 67, 68, 69, 70, 71],
                    where: roofsWhereClause
                }, {
                    headers: buildQuickbaseHeaders()
                });

                roofs = Array.isArray(roofsResponse?.data?.data)
                    ? roofsResponse.data.data
                    : [];
            }

            // Query JOB_PHOTOS for photos associated with this service order
            const photoResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                from: TABLES.JOB_PHOTOS,
                select: [3, 6, 7, 8, 9],
                where: `{'9'.EX.'${normalizedServiceOrderId}'}`
            }, {
                headers: buildQuickbaseHeaders()
            });

            const photoRows = Array.isArray(photoResponse?.data?.data) ? photoResponse.data.data : [];

            console.log('[EstimateRetrieve] Photo data retrieved', {
                serviceOrderId: normalizedServiceOrderId,
                photoCount: photoRows.length
            });

            // Download photo files and convert to base64
            const photos = await Promise.all(photoRows.map(async (photo) => {
                const fileRef = photo['8']?.value;
                const photoRecordId = photo['3']?.value;
                let base64Data = '';

                if (fileRef && fileRef.url && photoRecordId) {
                    try {
                        const fileUrl = `${QB_API_ENDPOINT}/files/${TABLES.JOB_PHOTOS}/${photoRecordId}/8/1`;
                        const fileResponse = await axios.get(fileUrl, {
                            headers: buildQuickbaseHeaders(),
                            responseType: 'arraybuffer'
                        });

                        const buffer = Buffer.from(fileResponse.data);
                        const base64String = buffer.toString('utf-8').trim();

                        const fileName = fileRef.versions?.[0]?.fileName || '';
                        const extension = fileName.split('.').pop()?.toLowerCase() || '';
                        let mimeType = 'image/png';

                        if (base64String.startsWith('/9j/')) {
                            mimeType = 'image/jpeg';
                        } else if (extension === 'jpg' || extension === 'jpeg') {
                            mimeType = 'image/jpeg';
                        }

                        base64Data = `data:${mimeType};base64,${base64String}`;
                    } catch (fileError) {
                        console.error('[EstimateRetrieve][Photo Download Error]', {
                            photoRecordId,
                            error: fileError.message
                        });
                    }
                }

                return {
                    recordId: photoRecordId,
                    photoType: photo['6']?.value || '',
                    roofId: photo['7']?.value || '',
                    dataUrl: base64Data,
                    serviceOrderId: photo['9']?.value || ''
                };
            }));

            // Build response payload
            const responseData = {
                serviceOrder: {
                    recordId: serviceOrder['3']?.value,
                    status: serviceOrder['11']?.value,
                    stage: serviceOrder['40']?.value,
                    subtotal: serviceOrder['137']?.value || 0,
                    taxAmount: serviceOrder['66']?.value || 0,
                    totalAmount: serviceOrder['67']?.value || 0,
                    secondaryDiscountAmount: serviceOrder['83']?.value || 0,
                    serviceNotes: serviceOrder['73']?.value || '',
                    cleanMaintenanceScheduledFor: serviceOrder['154']?.value || '',
                    repairServicesScheduledFor: serviceOrder['155']?.value || '',
                    soldDate: serviceOrder['69']?.value || '',
                    customerFirstName: serviceOrder['93']?.value || '',
                    customerLastName: serviceOrder['94']?.value || '',
                    customerPhone: serviceOrder['95']?.value || '',
                    locationAddressStreet: serviceOrder['106']?.value || '',
                    locationAddressCity: serviceOrder['92']?.value || '',
                    locationAddressZip: serviceOrder['105']?.value || '',
                    locationEmail: serviceOrder['142']?.value || serviceOrder['57']?.value || ''
                },
                lineItems: lineItems.map(item => ({
                    recordId: item['3']?.value,
                    offeredServiceItemId: item['17']?.value,
                    description: item['19']?.value,
                    qtyNeeded: item['16']?.value || 1,
                    sqFootage: item['23']?.value || 0,
                    price: item['18']?.value || 0,
                    lineSubtotal: item['24']?.value || 0,
                    specialInstructions: String(item['29']?.value || '').trim()
                })),
                roofs: roofs.map(roof => ({
                    recordId: roof['3']?.value,
                    name: roof['60']?.value || '',
                    material: roof['69']?.value || '',
                    pitch: roof['63']?.value || '',
                    squareFootage: roof['61']?.value || 0,
                    type: roof['67']?.value || '',
                    status: roof['59']?.value || ''
                })),
                roofAssociations: serviceOrderRoofs.map(assoc => ({
                    roofRecordId: assoc['22']?.value
                })),
                photos: photos
            };

            console.log('[EstimateRetrieve] Retrieval successful', {
                serviceOrderId: normalizedServiceOrderId,
                lineItemCount: responseData.lineItems.length,
                roofCount: responseData.roofs.length,
                photoCount: responseData.photos.length
            });

            return res.json({ success: true, data: responseData });

        } catch (error) {
            console.error('[EstimateRetrieve] Retrieval failed', {
                serviceOrderId: normalizedServiceOrderId,
                error: error.message
            });
            return res.status(500).json({
                success: false,
                message: 'Failed to retrieve estimate data'
            });
        }
    });

    app.post('/api/estimate/submit', async (req, res) => {
            const submissionData = req.body;

            // 1. Send the 202 Accepted status immediately
            // This tells the PWA "I have the data, you can stop waiting"
            res.status(202).json({ success: true, message: 'Data received, processing email in background' });

            // 2. Now run the heavy lifting (PDF generation + Emailing) in the background
            // We do NOT 'await' this, so it doesn't block the response
            generateAndSendEmail(submissionData).catch(err => {
                console.error('Background Email/PDF Failure:', err);
            });
        });

    // --- QUERY ROOFS BY LOCATION ---
    app.post('/roofs/query', async (req, res) => {
        const { locationId } = req.body || {};

        console.log('[Roofs][Query] Incoming request payload:', req.body || {});

        const normalizedLocationId = String(locationId || '').trim();
        if (!normalizedLocationId) {
            console.warn('[Roofs][Query] Rejected request: missing locationId.');
            return res.status(400).json({ success: false, message: 'locationId is required' });
        }

        const escapedLocationId = normalizedLocationId.replace(/'/g, "\\'");
        const whereClause = `{'7'.EX.'${escapedLocationId}'}`;
        console.log('[Roofs][Query] Executing Quickbase query.', {
            tableId: TABLES.ROOFS,
            where: whereClause,
            // Include both reference IDs (64/66/68/70) and display lookups (65/67/69/71).
            select: [3, 7, 59, 60, 61, 63, 64, 65, 66, 67, 68, 69, 70, 71]
        });

        try {
            const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                from: TABLES.ROOFS,
                select: [3, 7, 59, 60, 61, 63, 64, 65, 66, 67, 68, 69, 70, 71],
                where: whereClause
            }, {
                headers: {
                    'QB-Realm-Hostname': QB_REALM_HOST,
                    'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                }
            });

            const data = Array.isArray(response.data.data) ? response.data.data : [];
            console.log('[Roofs][Query] Quickbase response received.', {
                locationId: normalizedLocationId,
                returnedCount: data.length,
                firstRecordRelatedLocationFid7: data[0]?.['7']?.value ?? null,
                firstRecord: data[0] || null
            });
            return res.json({ success: true, data });
        } catch (error) {
            console.error('Roofs Query Error:', error.response ? error.response.data : error.message);
            return res.status(500).json({ success: false, message: 'Error retrieving roofs' });
        }
    });

    // --- GET ROOF LOOKUP OPTIONS (PITCH/MATERIAL/TYPE/BRAND/COLOR) ---
    app.post('/roofs/options', async (req, res) => {
        try {
            const [
                pitchOptions,
                roofAreaOptions,
                materialOptionRecords,
                typeOptionRecords,
                brandOptionRecords,
                colorOptionRecords
            ] = await Promise.all([
                queryRoofPitchChoices(),
                queryRoofAreaChoices(),
                queryActiveLookupOptionRecords(TABLES.ROOF_MATERIALS, 10, 11),
                queryActiveLookupOptionRecords(TABLES.ROOF_TYPES, 6, 7),
                queryActiveLookupOptionRecords(TABLES.ROOF_BRANDS, 8, 9),
                queryActiveLookupOptionRecords(TABLES.ROOF_COLORS, 8, 9)
            ]);

            const materialOptions = uniqueNonEmptyStrings(materialOptionRecords.map((option) => option.label));
            const typeOptions = uniqueNonEmptyStrings(typeOptionRecords.map((option) => option.label));
            const brandOptions = uniqueNonEmptyStrings(brandOptionRecords.map((option) => option.label));
            const colorOptions = uniqueNonEmptyStrings(colorOptionRecords.map((option) => option.label));

            return res.json({
                success: true,
                data: {
                    pitchOptions,
                    roofAreaOptions,
                    materialOptions,
                    typeOptions,
                    brandOptions,
                    colorOptions,
                    materialOptionRecords,
                    typeOptionRecords,
                    brandOptionRecords,
                    colorOptionRecords
                }
            });
        } catch (error) {
            console.error('Roof Options Query Error:', error.response ? error.response.data : error.message);
            return res.status(500).json({ success: false, message: 'Error retrieving roof options' });
        }
    });

    // --- ADD NEW ROOF RECORD ---
    app.post('/roofs/add', async (req, res) => {
        const { locationId, label, material, pitch, roofType, brand, color, sqft } = req.body || {};

        if (!locationId) {
            return res.status(400).json({ success: false, message: 'locationId is required' });
        }

        const normalizedLocationId = String(locationId || '').trim();
        const parsedLocationId = Number.parseInt(normalizedLocationId, 10);
        const relatedLocationValue = Number.isFinite(parsedLocationId)
            ? parsedLocationId
            : normalizedLocationId;

        const record = {
            7: { value: relatedLocationValue },
            60: { value: String(label || '') },
            63: { value: String(pitch || '') },
            59: { value: 'Active' }
        };

        if (sqft !== undefined && sqft !== '') {
            record[61] = { value: Number(sqft) || 0 };
        }

        if (material !== undefined && String(material).trim() !== '') {
            const parsedMaterialId = parseStrictNumericId(material);
            const materialId = Number.isFinite(parsedMaterialId)
                ? parsedMaterialId
                : await tryResolveLookupRecordId(TABLES.ROOF_MATERIALS, 10, material);

            if (materialId === null) {
                return res.status(400).json({
                    success: false,
                    message: `No material lookup record found for label: ${material}`
                });
            }

            record[68] = { value: materialId };
        }

        if (roofType !== undefined && String(roofType).trim() !== '') {
            const parsedRoofTypeId = parseStrictNumericId(roofType);
            const roofTypeId = Number.isFinite(parsedRoofTypeId)
                ? parsedRoofTypeId
                : await tryResolveLookupRecordId(TABLES.ROOF_TYPES, 6, roofType);

            if (roofTypeId === null) {
                return res.status(400).json({
                    success: false,
                    message: `No roof type lookup record found for label: ${roofType}`
                });
            }

            record[66] = { value: roofTypeId };
        }

        if (brand !== undefined && String(brand).trim() !== '') {
            const parsedBrandId = parseStrictNumericId(brand);
            const brandId = Number.isFinite(parsedBrandId)
                ? parsedBrandId
                : await tryResolveLookupRecordId(TABLES.ROOF_BRANDS, 8, brand);

            if (brandId === null) {
                return res.status(400).json({
                    success: false,
                    message: `No brand lookup record found for label: ${brand}`
                });
            }

            record[70] = { value: brandId };
        }

        if (color !== undefined && String(color).trim() !== '') {
            const parsedColorId = parseStrictNumericId(color);
            const colorId = Number.isFinite(parsedColorId)
                ? parsedColorId
                : await tryResolveLookupRecordId(TABLES.ROOF_COLORS, 8, color);

            if (colorId === null) {
                return res.status(400).json({
                    success: false,
                    message: `No color lookup record found for label: ${color}`
                });
            }

            record[64] = { value: colorId };
        }

        try {
            const response = await axios.post(`${QB_API_ENDPOINT}/records`, {
                to: TABLES.ROOFS,
                data: [record],
                fieldsToReturn: [3]
            }, {
                headers: {
                    'QB-Realm-Hostname': QB_REALM_HOST,
                    'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                }
            });

            const newId = response?.data?.metadata?.createdRecordIds?.[0];
            return res.json({ success: true, recordId: newId ? String(newId) : null });
        } catch (error) {
            console.error('Add Roof Error:', error.response ? error.response.data : error.message);
            return res.status(500).json({ success: false, message: 'Error adding roof record' });
        }
    });

    // --- UPDATE EXISTING ROOF RECORD ---
    const handleRoofUpdate = async (req, res) => {
        console.log('============ BACKEND ROOF UPDATE MUTATION INTERCEPT ============');
        console.log('[Roofs][Update] Request URL Trace:', {
            method: req.method,
            originalUrl: req.originalUrl || null,
            url: req.url || null,
            path: req.path || null
        });
        console.log('Inbound Payload Body Object:', req.body);

        const {
            recordId,
            roofId,
            fields,
            label,
            materialId,
            material,
            pitch,
            roofTypeId,
            roofType,
            brandId,
            brand,
            colorId,
            color,
            sqft,
            status
        } = req.body || {};

        const resolvedRecordId = recordId ?? roofId;
        const inboundFields = fields && typeof fields === 'object' ? fields : {};

        if (!resolvedRecordId) {
            return res.status(400).json({ success: false, message: 'recordId is required' });
        }

        const normalizedRecordId = Number.parseInt(resolvedRecordId, 10);
        if (!Number.isFinite(normalizedRecordId)) {
            return res.status(400).json({ success: false, message: 'recordId must be numeric' });
        }

        const referenceFieldIds = new Set(['64', '66', '68', '70']);
        const writableFieldSet = new Set(WRITABLE_FIELDS);
        const normalizedIncomingFields = {};

        for (const [rawFid, rawVal] of Object.entries(inboundFields)) {
            const fid = String(rawFid);

            if (fid === '67' || fid === '69' || fid === '71') {
                console.log('[Roofs][Update] Ignoring read-only lookup text field:', fid);
                continue;
            }

            if (!writableFieldSet.has(fid)) {
                continue;
            }

            if (referenceFieldIds.has(fid)) {
                const parsedRefId = Number.parseInt(rawVal, 10);
                if (!Number.isFinite(parsedRefId)) {
                    return res.status(400).json({
                        success: false,
                        message: `Field ${fid} requires a numeric Quickbase Record ID`
                    });
                }

                normalizedIncomingFields[fid] = parsedRefId;
                continue;
            }

            if (fid === '61') {
                normalizedIncomingFields[fid] = Number(rawVal) || 0;
                continue;
            }

            if (fid === '3') {
                const parsedRecordId = Number.parseInt(rawVal, 10);
                if (!Number.isFinite(parsedRecordId)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Field 3 requires a numeric Quickbase Record ID'
                    });
                }

                normalizedIncomingFields[fid] = parsedRecordId;
                continue;
            }

            normalizedIncomingFields[fid] = rawVal;
        }

        if (sqft !== undefined && writableFieldSet.has('61')) normalizedIncomingFields['61'] = Number(sqft) || 0;
        if (pitch !== undefined && writableFieldSet.has('63')) normalizedIncomingFields['63'] = pitch;

        if (label !== undefined) {
            console.log('[Roofs][Update] Ignoring non-writable field alias: label -> 60');
        }
        if (status !== undefined) {
            console.log('[Roofs][Update] Ignoring non-writable field alias: status -> 59');
        }

        const resolvedMaterialId = materialId ?? material;
        if (resolvedMaterialId !== undefined && writableFieldSet.has('68')) {
            const parsedMaterialId = parseStrictNumericId(resolvedMaterialId);
            if (Number.isFinite(parsedMaterialId)) {
                normalizedIncomingFields['68'] = parsedMaterialId;
            } else {
                const materialLookupId = await tryResolveLookupRecordId(TABLES.ROOF_MATERIALS, 10, resolvedMaterialId);
                if (materialLookupId !== null) {
                    normalizedIncomingFields['68'] = materialLookupId;
                    console.log('[Roofs][Update] Resolved material text to ID:', {
                        label: resolvedMaterialId,
                        id: materialLookupId
                    });
                } else {
                    console.warn('[Roofs][Update] Could not resolve material text; skipping:', {
                        label: resolvedMaterialId
                    });
                }
            }
        }

        const resolvedRoofTypeId = roofTypeId ?? roofType;
        if (resolvedRoofTypeId !== undefined && writableFieldSet.has('66')) {
            const parsedRoofTypeId = parseStrictNumericId(resolvedRoofTypeId);
            if (Number.isFinite(parsedRoofTypeId)) {
                normalizedIncomingFields['66'] = parsedRoofTypeId;
            } else {
                const roofTypeLookupId = await tryResolveLookupRecordId(TABLES.ROOF_TYPES, 6, resolvedRoofTypeId);
                if (roofTypeLookupId !== null) {
                    normalizedIncomingFields['66'] = roofTypeLookupId;
                    console.log('[Roofs][Update] Resolved roof type text to ID:', {
                        label: resolvedRoofTypeId,
                        id: roofTypeLookupId
                    });
                } else {
                    const brandLookupId = await tryResolveLookupRecordId(TABLES.ROOF_BRANDS, 8, resolvedRoofTypeId);
                    if (brandLookupId !== null && normalizedIncomingFields['70'] === undefined) {
                        normalizedIncomingFields['70'] = brandLookupId;
                        console.log('[Roofs][Update] Resolved roofType text as brand ID fallback:', {
                            label: resolvedRoofTypeId,
                            id: brandLookupId
                        });
                    } else {
                        console.warn('[Roofs][Update] Could not resolve roof type text; skipping:', {
                            label: resolvedRoofTypeId
                        });
                    }
                }
            }
        }

        const resolvedBrandId = brandId ?? brand;
        if (resolvedBrandId !== undefined && writableFieldSet.has('70')) {
            const parsedBrandId = parseStrictNumericId(resolvedBrandId);
            if (Number.isFinite(parsedBrandId)) {
                normalizedIncomingFields['70'] = parsedBrandId;
            } else {
                const brandLookupId = await tryResolveLookupRecordId(TABLES.ROOF_BRANDS, 8, resolvedBrandId);
                if (brandLookupId !== null) {
                    normalizedIncomingFields['70'] = brandLookupId;
                    console.log('[Roofs][Update] Resolved brand text to ID:', {
                        label: resolvedBrandId,
                        id: brandLookupId
                    });
                } else {
                    const roofTypeLookupId = await tryResolveLookupRecordId(TABLES.ROOF_TYPES, 6, resolvedBrandId);
                    if (roofTypeLookupId !== null && normalizedIncomingFields['66'] === undefined) {
                        normalizedIncomingFields['66'] = roofTypeLookupId;
                        console.log('[Roofs][Update] Resolved brand text as roof type ID fallback:', {
                            label: resolvedBrandId,
                            id: roofTypeLookupId
                        });
                    } else {
                        console.warn('[Roofs][Update] Could not resolve brand text; skipping:', {
                            label: resolvedBrandId
                        });
                    }
                }
            }
        }

        const resolvedColorId = colorId ?? color;
        if (resolvedColorId !== undefined && writableFieldSet.has('64')) {
            const parsedColorId = parseStrictNumericId(resolvedColorId);
            if (Number.isFinite(parsedColorId)) {
                normalizedIncomingFields['64'] = parsedColorId;
            } else {
                const colorLookupId = await tryResolveLookupRecordId(TABLES.ROOF_COLORS, 8, resolvedColorId);
                if (colorLookupId !== null) {
                    normalizedIncomingFields['64'] = colorLookupId;
                    console.log('[Roofs][Update] Resolved color text to ID:', {
                        label: resolvedColorId,
                        id: colorLookupId
                    });
                } else {
                    console.warn('[Roofs][Update] Could not resolve color text; skipping:', {
                        label: resolvedColorId
                    });
                }
            }
        }

        if (inboundFields['69'] !== undefined && normalizedIncomingFields['68'] === undefined && writableFieldSet.has('68')) {
            try {
                const materialLookupId = await resolveLookupRecordId(TABLES.ROOF_MATERIALS, 10, inboundFields['69'], 'material');
                normalizedIncomingFields['68'] = materialLookupId;
                console.log('[Roofs][Update] Resolved fields[69] text to material ID:', {
                    label: inboundFields['69'],
                    id: materialLookupId
                });
            } catch (lookupError) {
                return res.status(400).json({
                    success: false,
                    message: lookupError.message
                });
            }
        }

        if (inboundFields['67'] !== undefined && normalizedIncomingFields['66'] === undefined && writableFieldSet.has('66')) {
            const roofTypeLookupId = await tryResolveLookupRecordId(TABLES.ROOF_TYPES, 6, inboundFields['67']);
            if (roofTypeLookupId !== null) {
                normalizedIncomingFields['66'] = roofTypeLookupId;
                console.log('[Roofs][Update] Resolved fields[67] text to roof type ID:', {
                    label: inboundFields['67'],
                    id: roofTypeLookupId
                });
            } else {
                const brandLookupId = await tryResolveLookupRecordId(TABLES.ROOF_BRANDS, 8, inboundFields['67']);
                if (brandLookupId !== null && normalizedIncomingFields['70'] === undefined && writableFieldSet.has('70')) {
                    normalizedIncomingFields['70'] = brandLookupId;
                    console.log('[Roofs][Update] Resolved fields[67] text to brand ID fallback:', {
                        label: inboundFields['67'],
                        id: brandLookupId
                    });
                } else {
                    console.warn('[Roofs][Update] Could not resolve fields[67] text; skipping:', {
                        label: inboundFields['67']
                    });
                }
            }
        }

        if (inboundFields['71'] !== undefined && normalizedIncomingFields['70'] === undefined && writableFieldSet.has('70')) {
            const brandLookupId = await tryResolveLookupRecordId(TABLES.ROOF_BRANDS, 8, inboundFields['71']);
            if (brandLookupId !== null) {
                normalizedIncomingFields['70'] = brandLookupId;
                console.log('[Roofs][Update] Resolved fields[71] text to brand ID:', {
                    label: inboundFields['71'],
                    id: brandLookupId
                });
            } else {
                const roofTypeLookupId = await tryResolveLookupRecordId(TABLES.ROOF_TYPES, 6, inboundFields['71']);
                if (roofTypeLookupId !== null && normalizedIncomingFields['66'] === undefined && writableFieldSet.has('66')) {
                    normalizedIncomingFields['66'] = roofTypeLookupId;
                    console.log('[Roofs][Update] Resolved fields[71] text to roof type ID fallback:', {
                        label: inboundFields['71'],
                        id: roofTypeLookupId
                    });
                } else {
                    console.warn('[Roofs][Update] Could not resolve fields[71] text; skipping:', {
                        label: inboundFields['71']
                    });
                }
            }
        }

        if (inboundFields['65'] !== undefined && normalizedIncomingFields['64'] === undefined && writableFieldSet.has('64')) {
            try {
                const colorLookupId = await resolveLookupRecordId(TABLES.ROOF_COLORS, 8, inboundFields['65'], 'color');
                normalizedIncomingFields['64'] = colorLookupId;
                console.log('[Roofs][Update] Resolved fields[65] text to color ID:', {
                    label: inboundFields['65'],
                    id: colorLookupId
                });
            } catch (lookupError) {
                return res.status(400).json({
                    success: false,
                    message: lookupError.message
                });
            }
        }

        try {
            const existingLookup = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
                from: TABLES.ROOFS,
                select: [3, 59, 60, 61, 63, 64, 65, 66, 67, 68, 69, 70, 71],
                where: `{'3'.EX.'${normalizedRecordId}'}`
            }, {
                headers: {
                    'QB-Realm-Hostname': QB_REALM_HOST,
                    'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                }
            });

            const existingRecord = existingLookup?.data?.data?.[0] || { 3: { value: normalizedRecordId } };

            // Correct Merge: Use existing as base, then override with new fields
            const finalRecord = { ...existingRecord };
            for (const [fid, val] of Object.entries(normalizedIncomingFields)) {
                if (fid === '61') {
                    finalRecord[fid] = { value: Number(val) || 0 };
                } else if (referenceFieldIds.has(fid)) {
                    finalRecord[fid] = { value: Number.parseInt(val, 10) };
                } else {
                    finalRecord[fid] = { value: val };
                }
            }

            const READ_ONLY_FIELDS = ['67', '69', '71'];
            READ_ONLY_FIELDS.forEach((fid) => delete finalRecord[fid]);

            // Final safety gate: only send writable fields to Quickbase mutation endpoint.
            Object.keys(finalRecord).forEach((fid) => {
                if (!writableFieldSet.has(fid)) {
                    delete finalRecord[fid];
                }
            });

            // Ensure RID is always present in the mutation body.
            if (!finalRecord['3']) {
                finalRecord['3'] = { value: normalizedRecordId };
            }

            console.log('[Roofs][Update] Final Quickbase mutation payload (finalRecord):', finalRecord);
            console.log('[Roofs][Update] Mapped Quickbase record payload:', finalRecord);

            const qbPayload = {
                to: 'bt73uh9ie',
                data: [finalRecord],
                fieldsToReturn: [63, 69, 61, 71, 65]
            };

            console.log('--- FINAL API PAYLOAD ---', JSON.stringify(qbPayload, null, 2));

            const result = await axios.post(`${QB_API_ENDPOINT}/records`, qbPayload, {
                headers: {
                    'QB-Realm-Hostname': QB_REALM_HOST,
                    'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                }
            });

            console.log('--- QUICKBASE API RESPONSE ---', {
                status: result?.status || null,
                statusText: result?.statusText || null,
                data: result?.data || null
            });

            const lineErrors = result?.data?.metadata?.lineErrors || null;
            if (result?.status === 207 || (lineErrors && Object.keys(lineErrors).length > 0)) {
                console.error('--- QUICKBASE LINE ERRORS ---', JSON.stringify(lineErrors, null, 2));
                return res.status(502).json({
                    success: false,
                    message: 'Quickbase rejected one or more fields in mutation payload',
                    quickbaseStatus: result?.status || null,
                    lineErrors
                });
            }

            return res.json({ success: true, recordId: String(normalizedRecordId) });
        } catch (error) {
            console.error('Update Roof Error:', {
                message: error?.message || null,
                status: error?.response?.status || null,
                statusText: error?.response?.statusText || null,
                data: error?.response?.data || null
            });
            return res.status(500).json({ success: false, message: 'Error updating roof record' });
        }
    };

// Register both variants so local calls are caught regardless of mounting path assumptions.
app.post('/roofs/update', handleRoofUpdate);
app.post('/api/roofs/update', handleRoofUpdate);

// --- GET HISTORICAL INSPECTION DATA ---
app.get('/inspection/historical/:serviceOrderId', async (req, res) => {
    const { serviceOrderId } = req.params || {};

    if (!serviceOrderId) {
        return res.status(400).json({ success: false, message: 'serviceOrderId is required' });
    }

    const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
    if (!Number.isFinite(normalizedServiceOrderId)) {
        return res.status(400).json({ success: false, message: 'serviceOrderId must be numeric' });
    }

    try {
        // Query service order for masterJobRecordValues
        const serviceOrderResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.SERVICE_ORDERS,
            select: [3, 48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 59, 118, 120, 121, 122, 123, 124, 125, 126, 153],
            where: `{'3'.EX.'${normalizedServiceOrderId}'}`
        }, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        const serviceOrderRecord = serviceOrderResponse?.data?.data?.[0] || null;
        if (!serviceOrderRecord) {
            return res.status(404).json({ success: false, message: 'Service order not found' });
        }

        // Query photo table for photos
        const photoResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.JOB_PHOTOS,
            select: [3, 6, 7, 8, 9],
            where: `{'9'.EX.'${normalizedServiceOrderId}'}`
        }, {
            headers: {
                'QB-Realm-Hostname': QB_REALM_HOST,
                'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
            }
        });

        const photoRows = photoResponse?.data?.data || [];

        console.log('[Historical Inspection][Photo Data]', JSON.stringify({
            photoCount: photoRows.length,
            samplePhoto: photoRows[0] || null
        }, null, 2));

        // Download photo files and convert to base64
        const photoRowsWithBase64 = await Promise.all(photoRows.map(async (photo) => {
            const fileRef = photo['8']?.value;
            const photoRecordId = photo['3']?.value;
            let base64Data = '';

            if (fileRef && fileRef.url && photoRecordId) {
                try {
                    // Construct file download URL using record ID and field ID
                    const fileUrl = `${QB_API_ENDPOINT}/files/${TABLES.JOB_PHOTOS}/${photoRecordId}/8/1`;
                    console.log('[Historical Inspection][Downloading File]', { fileUrl, photoRecordId });
                    const fileResponse = await axios.get(fileUrl, {
                        headers: {
                            'QB-Realm-Hostname': QB_REALM_HOST,
                            'Authorization': `QB-USER-TOKEN ${QB_TOKEN}`
                        },
                        responseType: 'arraybuffer'
                    });

                    // QuickBase returns base64-encoded data, not raw binary
                    // Decode the buffer as UTF-8 to get the base64 string
                    const buffer = Buffer.from(fileResponse.data);
                    const base64String = buffer.toString('utf-8').trim();

                    // Detect MIME type from base64 signature or file extension
                    const fileName = fileRef.versions?.[0]?.fileName || '';
                    const extension = fileName.split('.').pop()?.toLowerCase() || '';
                    let mimeType = 'image/png';

                    // Check base64 signature for JPEG
                    if (base64String.startsWith('/9j/')) {
                        mimeType = 'image/jpeg';
                    } else if (extension === 'jpg' || extension === 'jpeg') {
                        mimeType = 'image/jpeg';
                    }

                    base64Data = `data:${mimeType};base64,${base64String}`;
                    console.log('[Historical Inspection][File Download Success]', {
                        photoRecordId,
                        fileName,
                        mimeType,
                        bufferSize: fileResponse.data?.length || 0,
                        base64Length: base64String.length,
                        totalDataUrlLength: base64Data.length,
                        preview: base64Data.substring(0, 100)
                    });
                } catch (fileError) {
                    console.error('[Historical Inspection][File Download Error]', {
                        photoRecordId,
                        attemptedUrl: `${QB_API_ENDPOINT}/files/${TABLES.JOB_PHOTOS}/${photoRecordId}/8/1`,
                        error: fileError.message,
                        status: fileError.response?.status,
                        responseData: fileError.response?.data
                    });
                }
            }

            return {
                fid_6: photo['6']?.value !== undefined ? photo['6'].value : photo['6'],
                fid_7: photo['7']?.value !== undefined ? photo['7'].value : photo['7'],
                fid_8: base64Data,
                fid_9: photo['9']?.value !== undefined ? photo['9'].value : photo['9']
            };
        }));

        // Build masterJobRecordValues object
        const masterJobRecordValues = {};
        const inspectionFields = [48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 59, 118, 120, 121, 122, 123, 124, 125, 126, 153];
        inspectionFields.forEach(fid => {
            const value = serviceOrderRecord[String(fid)];
            if (value !== undefined && value !== null) {
                masterJobRecordValues[String(fid)] = value.value !== undefined ? value.value : value;
            }
        });

        // Build photoBatchData
        const photoBatchData = {
            tableId: TABLES.JOB_PHOTOS,
            rows: photoRowsWithBase64
        };

        console.log('[Historical Inspection][Photo Batch Data]', JSON.stringify({
            photoCount: photoBatchData.rows.length,
            firstRowFid8Type: typeof photoBatchData.rows[0]?.fid_8,
            firstRowFid8Value: photoBatchData.rows[0]?.fid_8?.substring(0, 100) || photoBatchData.rows[0]?.fid_8
        }, null, 2));

        const inspectionCache = {
            serviceOrderId: String(normalizedServiceOrderId),
            masterJobRecordValues,
            photoBatchData,
            photoCount: photoRows.length,
            cachedAt: new Date().toISOString()
        };

        return res.json({ success: true, data: inspectionCache });
    } catch (error) {
        console.error('Historical Inspection Query Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error retrieving historical inspection data' });
    }
});

// --- RINGCENTRAL AUTH VERIFICATION ENDPOINT ---
app.get('/ringcentral/verify-auth', async (req, res) => {
    console.log('[RingCentral][VerifyAuth] Auth + SMS test requested');
    try {
        const clientId = rcClientId.value();
        const clientSecret = rcClientSecret.value();
        const jwt = rcJwt.value();

        if (!clientId || !clientSecret || !jwt) {
            console.error('[RingCentral][VerifyAuth] One or more RC secrets are missing');
            return res.status(500).json({
                success: false,
                message: 'One or more RingCentral secrets are not configured (RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT)'
            });
        }

        const rcsdk = new RingCentralSDK({
            server: 'https://platform.ringcentral.com',
            clientId,
            clientSecret
        });
        const platform = rcsdk.platform();

        await platform.login({ jwt });

        const authData = platform.auth().data();
        console.log('[RingCentral][VerifyAuth] Authentication successful', {
            tokenType: authData.token_type,
            expiresIn: authData.expires_in,
            scope: authData.scope
        });

        // Discover a phone number on this extension that has the SmsSender feature
        const phoneNumberResp = await platform.get('/restapi/v1.0/account/~/extension/~/phone-number');
        const phoneNumberJson = await phoneNumberResp.json();
        const smsCapableNumber = (phoneNumberJson.records || []).find(
            (record) => Array.isArray(record.features) && record.features.includes('SmsSender')
        );

        if (!smsCapableNumber) {
            console.error('[RingCentral][VerifyAuth] No SMS-capable phone number found on this extension');
            return res.status(500).json({
                success: false,
                message: 'Authentication succeeded but no phone number with SmsSender feature was found on this extension'
            });
        }

        const fromNumber = smsCapableNumber.phoneNumber;
        console.log('[RingCentral][VerifyAuth] Sending test SMS', { from: fromNumber, to: '+12063052553' });

        const smsResp = await platform.post('/restapi/v1.0/account/~/extension/~/sms', {
            from: { phoneNumber: fromNumber },
            to: [{ phoneNumber: '+12063052553' }],
            text: 'This is a test SMS from the TRM Mobile application.'
        });
        const smsJson = await smsResp.json();

        console.log('[RingCentral][VerifyAuth] SMS accepted', {
            messageId: smsJson.id,
            messageStatus: smsJson.messageStatus,
            from: fromNumber
        });

        return res.status(200).json({
            success: true,
            message: 'RingCentral authentication and SMS dispatch successful',
            smsMessageId: smsJson.id,
            smsMessageStatus: smsJson.messageStatus,
            fromNumber,
            tokenType: authData.token_type,
            scope: authData.scope
        });
    } catch (err) {
        console.error('[RingCentral][VerifyAuth] Failed', {
            message: err.message,
            stack: err.stack
        });
        let errorDetail = err.message;
        try {
            const apiError = err.response ? await err.response.json() : null;
            if (apiError) {
                errorDetail = apiError;
            }
        } catch (_) {}
        return res.status(500).json({
            success: false,
            message: 'RingCentral operation failed',
            error: errorDetail
        });
    }
});

// --- GEOCODE CUSTOMER LOCATION ENDPOINT ---
app.post('/geocode-customer-location', async (req, res) => {
    const { pipelineSecret: providedSecret, recordId, street, street2, city, state, zip } = req.body || {};

    if (!providedSecret || providedSecret !== pipelineSecret.value()) {
        console.warn('[Geocode] Unauthorized request blocked', { ip: req.ip });
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    if (!recordId || !street || !city || !state || !zip) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: recordId, street, city, state, zip'
        });
    }

    const addressParts = [street];
    if (street2 && String(street2).trim()) {
        addressParts.push(String(street2).trim());
    }
    addressParts.push(city, state, zip);
    const fullAddress = addressParts.join(', ');

    console.log('[Geocode] Geocoding address', { recordId, fullAddress });

    let lat, lng;
    try {
        const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json` +
            `?address=${encodeURIComponent(fullAddress)}` +
            `&key=${googleMapsApiKey.value()}`;

        const geocodeResp = await axios.get(geocodeUrl, { timeout: 8000 });
        const results = geocodeResp.data?.results;

        if (!Array.isArray(results) || results.length === 0 || geocodeResp.data?.status !== 'OK') {
            console.warn('[Geocode] No results returned', {
                recordId,
                fullAddress,
                status: geocodeResp.data?.status
            });
            return res.status(200).json({
                success: false,
                message: `Geocoding returned no results (status: ${geocodeResp.data?.status})`,
                address: fullAddress
            });
        }

        const location = results[0].geometry.location;
        lat = location.lat;
        lng = location.lng;
        console.log('[Geocode] Coordinates resolved', { recordId, lat, lng });
    } catch (err) {
        console.error('[Geocode] Google Geocoding API call failed', {
            recordId,
            message: err.message
        });
        return res.status(500).json({
            success: false,
            message: 'Geocoding API request failed',
            error: err.message
        });
    }

    const locationsTable = TABLES.LOCATIONS;
    if (!locationsTable) {
        console.error('[Geocode] LOCATIONS table ID is not configured');
        return res.status(500).json({
            success: false,
            message: 'Server configuration error: LOCATIONS table ID is not set'
        });
    }

    try {
        await writeQuickbaseRecords(locationsTable, [
            {
                '3':   { value: Number.parseInt(recordId, 10) },
                '157': { value: lat },
                '158': { value: lng }
            }
        ], [3, 157, 158]);

        console.log('[Geocode] Customer Location record updated', { recordId, lat, lng });
        return res.status(200).json({
            success: true,
            message: 'Coordinates updated successfully',
            recordId: Number.parseInt(recordId, 10),
            latitude: lat,
            longitude: lng,
            address: fullAddress
        });
    } catch (err) {
        console.error('[Geocode] Quickbase record update failed', {
            recordId,
            message: err.message
        });
        return res.status(500).json({
            success: false,
            message: 'Failed to update Quickbase record',
            error: err.message
        });
    }
});

// --- GET SERVICE ORDER TASKS (with hydrated task photos) ---
app.post('/service-order/tasks', async (req, res) => {
    const { serviceOrderId } = req.body || {};

    const normalizedId = String(serviceOrderId || '').trim();
    if (!normalizedId) {
        return res.status(400).json({ success: false, message: 'serviceOrderId is required' });
    }

    const escapedId = normalizedId.replace(/'/g, "\\'");

    try {
        // 1. Fetch tasks
        const taskResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.SERVICE_ORDER_TASKS,
            select: [3, 9, 36, 37, 29, 38, 40, 30, 8, 18, 43, 44, 45],
            where: `{'9'.EX.'${escapedId}'}`,
            sortBy: [{ fieldId: 3, order: 'ASC' }]
        }, {
            headers: { 'QB-Realm-Hostname': QB_REALM_HOST, 'Authorization': `QB-USER-TOKEN ${QB_TOKEN}` }
        });

        const records = Array.isArray(taskResponse.data.data) ? taskResponse.data.data : [];
        const tasks = records.map(r => ({
            id:                     (r['3']?.value  ?? '').toString(),
            relatedServiceOrder:    (r['9']?.value  ?? '').toString(),
            taskName:               (r['36']?.value ?? '').toString().trim(),
            serviceCategory:        (r['37']?.value ?? '').toString().trim(),
            quantity:               r['29']?.value  ?? null,
            description:            (r['38']?.value ?? '').toString().trim(),
            specialInstructions:    (r['40']?.value ?? '').toString().trim(),
            technicianInstructions: (r['30']?.value ?? '').toString().trim(),
            taskStatus:             (r['8']?.value  ?? '').toString().trim(),
            taskOrigin:             (r['18']?.value ?? '').toString().trim(),
            estimatePrice:          r['43']?.value  ?? null,
            sqFootage:              r['44']?.value  ?? null,
            lineSubtotal:           r['45']?.value  ?? null,
            beforePhotos:           [],
            afterPhotos:            [],
        }));

        if (tasks.length === 0) {
            return res.json({ success: true, data: tasks });
        }

        // 2. Fetch all task photos for this service order from JOB_PHOTOS
        //    Section values are stored as "task-before-<taskId>" or "task-after-<taskId>"
        const photoResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.JOB_PHOTOS,
            select: [3, 6, 8, 9],
            where: `{'9'.EX.'${escapedId}'}`
        }, {
            headers: { 'QB-Realm-Hostname': QB_REALM_HOST, 'Authorization': `QB-USER-TOKEN ${QB_TOKEN}` }
        });

        const photoRecords = Array.isArray(photoResponse.data.data) ? photoResponse.data.data : [];

        // Build a download URL map per task
        // FID 6 = section tag, FID 8 = file attachment (contains url), FID 3 = record ID
        const taskPhotoMap = {};
        for (const photo of photoRecords) {
            const section = String(photo['6']?.value || '').trim();
            const recordId = String(photo['3']?.value || '').trim();
            const fileRef = photo['8']?.value;

            const beforeMatch = section.match(/^task-before-(\d+)$/);
            const afterMatch  = section.match(/^task-after-(\d+)$/);
            const taskId = beforeMatch?.[1] ?? afterMatch?.[1];
            if (!taskId || !recordId) continue;

            if (!taskPhotoMap[taskId]) taskPhotoMap[taskId] = { before: [], after: [] };

            let downloadUrl = '';
            if (fileRef && typeof fileRef === 'object' && fileRef.url) {
                downloadUrl = fileRef.url;
            } else {
                // Construct API download URL for version 1
                downloadUrl = `${QB_API_ENDPOINT}/files/${TABLES.JOB_PHOTOS}/${recordId}/8/1`;
            }

            if (beforeMatch) {
                taskPhotoMap[taskId].before.push({ recordId, url: downloadUrl });
            } else {
                taskPhotoMap[taskId].after.push({ recordId, url: downloadUrl });
            }
        }

        // 3. Attach photos to each task
        for (const task of tasks) {
            const photos = taskPhotoMap[task.id];
            if (photos) {
                task.beforePhotos = photos.before;
                task.afterPhotos  = photos.after;
            }
        }

        return res.json({ success: true, data: tasks });
    } catch (error) {
        console.error('[ServiceOrderTasks] Query error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Error retrieving service order tasks' });
    }
});

// --- UPLOAD TASK PHOTO ---
app.post('/service-order/task-photo/upload', async (req, res) => {
    const { serviceOrderId, taskId, slot, base64 } = req.body || {};

    const normalizedSoId = Number.parseInt(String(serviceOrderId || ''), 10);
    const normalizedTaskId = String(taskId || '').trim();
    const normalizedSlot  = String(slot  || '').trim().toLowerCase();
    const normalizedBase64 = String(base64 || '').trim()
        .replace(/^data:[^;]+;base64,/i, '')
        .replace(/\s+/g, '');

    if (!Number.isFinite(normalizedSoId)) {
        return res.status(400).json({ success: false, message: 'serviceOrderId must be numeric' });
    }
    if (!normalizedTaskId) {
        return res.status(400).json({ success: false, message: 'taskId is required' });
    }
    if (normalizedSlot !== 'before' && normalizedSlot !== 'after') {
        return res.status(400).json({ success: false, message: 'slot must be "before" or "after"' });
    }
    if (!normalizedBase64) {
        return res.status(400).json({ success: false, message: 'base64 photo data is required' });
    }

    const sectionTag = `task-${normalizedSlot}-${normalizedTaskId}`;
    const fileName = `task-${normalizedSlot}-${normalizedTaskId}-${Date.now()}.jpg`;

    try {
        const writeResponse = await axios.post(`${QB_API_ENDPOINT}/records`, {
            to: TABLES.JOB_PHOTOS,
            data: [{
                6: { value: sectionTag },
                7: { value: '' },
                8: { value: { fileName, data: normalizedBase64 } },
                9: { value: normalizedSoId }
            }],
            fieldsToReturn: [3, 8]
        }, {
            headers: { 'QB-Realm-Hostname': QB_REALM_HOST, 'Authorization': `QB-USER-TOKEN ${QB_TOKEN}` }
        });

        const createdRecord = writeResponse.data?.data?.[0];
        const recordId = String(createdRecord?.['3']?.value || '').trim();
        const fileRef  = createdRecord?.['8']?.value;

        let downloadUrl = '';
        if (fileRef && typeof fileRef === 'object' && fileRef.url) {
            downloadUrl = fileRef.url;
        } else if (recordId) {
            downloadUrl = `${QB_API_ENDPOINT}/files/${TABLES.JOB_PHOTOS}/${recordId}/8/1`;
        }

        return res.json({ success: true, recordId, url: downloadUrl });
    } catch (error) {
        console.error('[TaskPhotoUpload] Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: 'Photo upload failed' });
    }
});

// --- INTERNAL HELPER: Fetch tasks for Invoice line model ---
async function fetchServiceOrderTasksForInvoice(serviceOrderId) {
    const escapedId = String(serviceOrderId).trim().replace(/'/g, "\\'");
    // FID map: 3=id, 9=relatedServiceOrder, 36=taskName, 37=serviceCategory,
    //          29=quantity, 38=description, 8=taskStatus, 18=taskOrigin,
    //          43=estimatePrice, 44=sqFootage, 45=lineSubtotal
    const response = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
        from: TABLES.SERVICE_ORDER_TASKS,
        select: [3, 9, 36, 37, 29, 38, 8, 18, 43, 44, 45],
        where: `{'9'.EX.'${escapedId}'}`,
        sortBy: [{ fieldId: 3, order: 'ASC' }]
    }, {
        headers: { 'QB-Realm-Hostname': QB_REALM_HOST, 'Authorization': `QB-USER-TOKEN ${QB_TOKEN}` }
    });

    return Array.isArray(response.data.data) ? response.data.data : [];
}

function deriveLineStatus(taskOrigin, taskStatus) {
    const origin = String(taskOrigin || '').trim().toLowerCase();
    const status = String(taskStatus || '').trim().toLowerCase();
    if (status === 'cancelled') return 'Cancelled';
    if (origin === 'added')     return 'Added';
    if (origin === 'changed')   return 'Changed';
    return 'Estimate';
}

async function writeInvoiceLineItems(serviceOrderId, invoiceLineItems) {
    // 1. Query existing Invoice records for this Service Order, keyed by Related Task (FID 13)
    const existingResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
        from: TABLES.INVOICES,
        select: [3, 13],
        where: `{'6'.EX.'${String(serviceOrderId).trim().replace(/'/g, "\\'")}'}`
    }, {
        headers: { 'QB-Realm-Hostname': QB_REALM_HOST, 'Authorization': `QB-USER-TOKEN ${QB_TOKEN}` }
    });

    // Build a map of taskRecordId -> existing Invoice record ID
    const existingRecords = Array.isArray(existingResponse.data.data) ? existingResponse.data.data : [];
    const taskToInvoiceRecordId = {};
    for (const r of existingRecords) {
        const taskRecordId = String(r['13']?.value ?? '').trim();
        const invoiceRecordId = r['3']?.value;
        if (taskRecordId && invoiceRecordId) {
            taskToInvoiceRecordId[taskRecordId] = invoiceRecordId;
        }
    }

    // 2. Build upsert rows — include FID 3 when a matching record exists (update), omit it for new lines (insert)
    const rows = invoiceLineItems.map(line => {
        const existingId = taskToInvoiceRecordId[line.taskRecordId];
        const row = {
            6:  { value: serviceOrderId },
            7:  { value: line.taskName },
            8:  { value: line.description },
            9:  { value: line.quantity },
            10: { value: line.estimatePrice },
            11: { value: line.lineStatus },
            12: { value: line.lineSubtotal },
            13: { value: line.taskRecordId },
            15: { value: line.sqFootage },
        };
        if (existingId) {
            row[3] = { value: existingId };
        }
        return row;
    });

    const response = await writeQuickbaseRecords(TABLES.INVOICES, rows, [3]);
    const written = Array.isArray(response?.data?.data) ? response.data.data.length : rows.length;

    const updatedCount = rows.filter(r => !!r[3]).length;
    const insertedCount = rows.length - updatedCount;

    console.log('[SubmitServiceOrder] Invoice records upserted.', {
        serviceOrderId,
        inserted: insertedCount,
        updated: updatedCount,
        total: written,
    });

    return { inserted: insertedCount, updated: updatedCount, total: written };
}

function buildInvoiceLineItems(taskRecords) {
    return taskRecords.map(r => {
        const taskOrigin  = String(r['18']?.value ?? '').trim();
        const taskStatus  = String(r['8']?.value  ?? '').trim();
        const lineStatus  = deriveLineStatus(taskOrigin, taskStatus);
        const isCancelled = lineStatus === 'Cancelled';

        const quantity    = isCancelled ? 0 : (r['29']?.value ?? null);
        const estimatePrice = isCancelled ? 0 : (r['43']?.value ?? null);
        const sqFootage     = isCancelled ? 0 : (r['44']?.value ?? null);
        const lineSubtotal  = isCancelled ? 0 : (r['45']?.value ?? null);

        return {
            relatedServiceOrder: String(r['9']?.value  ?? '').trim(),
            taskRecordId:        String(r['3']?.value  ?? '').trim(),
            taskName:            String(r['36']?.value ?? '').trim(),
            description:         String(r['38']?.value ?? '').trim(),
            serviceCategory:     String(r['37']?.value ?? '').trim(),
            quantity,
            estimatePrice,
            sqFootage,
            lineSubtotal,
            lineStatus,
            taskOrigin,
            taskStatus,
        };
    });
}

// Resolve a QuickBase address field value into a structured address object.
// Handles native address objects, simple strings, and comma-separated strings.
function resolveAddressField(raw) {
    if (raw == null) {
        return { street1: null, street2: null, city: null, state: null, postalCode: null, country: null };
    }
    if (typeof raw === 'object') {
        return {
            street1:     String(raw.street1 ?? raw.street ?? '').trim() || null,
            street2:     String(raw.street2 ?? '').trim() || null,
            city:        String(raw.city ?? '').trim() || null,
            state:       String(raw.subdivision ?? raw.state ?? '').trim() || null,
            postalCode:  String(raw.postalCode ?? raw.zip ?? '').trim() || null,
            country:     String(raw.country ?? '').trim() || null,
        };
    }
    const str = String(raw).trim();
    if (!str) {
        return { street1: null, street2: null, city: null, state: null, postalCode: null, country: null };
    }
    // Expected QuickBase format: "Street, City, State PostalCode Country"
    // Example: "25606 69th Avenue East, Graham, Washington 98338 United States"
    const parts = str.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
        const last = parts[parts.length - 1];
        const stateZipCountryMatch = last.match(/^(.*?)\s+(\d{5}(-\d{4})?)\s*(.*)$/);
        if (stateZipCountryMatch) {
            return {
                street1:    parts.slice(0, parts.length - 2).join(', ') || null,
                street2:    null,
                city:       parts[parts.length - 2] || null,
                state:      stateZipCountryMatch[1].trim() || null,
                postalCode: stateZipCountryMatch[2] || null,
                country:    stateZipCountryMatch[4].trim() || null,
            };
        }
    }
    return { street1: str, street2: null, city: null, state: null, postalCode: null, country: null };
}

// --- INTERNAL HELPER: Build InvoiceData contract from persisted QuickBase data ---
async function buildInvoiceData(serviceOrderId, selectedPhotos = []) {
    const qbHeaders = { 'QB-Realm-Hostname': QB_REALM_HOST, 'Authorization': `QB-USER-TOKEN ${QB_TOKEN}` };
    const escapedId = String(serviceOrderId).trim().replace(/'/g, "\\'");

    // 1. Query parent Service Order
    // FID map (known from /job-detail and /estimate/retrieve):
    //   3=recordId, 6=relatedLocation, 7=relatedCustomer(numeric ref), 9=serviceDate,
    //   10=serviceType, 11=status, 15=relatedCustomer(customer recordId lookup),
    //   16=serviceSubtype, 40=stage, 57=locationEmail(alt), 66=taxAmount, 67=totalAmount,
    //   73=serviceNotes, 83=secondaryDiscountAmount, 90=locationAddress,
    //   93=customerFirstName, 94=customerLastName, 95=customerPhone,
    //   105=locationZip, 106=locationStreet, 107=locationState, 137=subtotal,
    //   142=locationEmail, 154=cleanMaintenanceScheduledFor, 155=repairServicesScheduledFor,
    //   163=billingAddressSameAsPrimary
    const soResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
        from: TABLES.SERVICE_ORDERS,
        select: [3, 6, 7, 9, 10, 11, 15, 16, 40, 57, 66, 67, 73, 83, 90, 92, 93, 94, 95, 105, 106, 107, 137, 138, 140, 142, 154, 155, 163],
        where: `{'3'.EX.'${escapedId}'}`
    }, { headers: qbHeaders });

    const soRecord = soResponse?.data?.data?.[0] || null;
    if (!soRecord) {
        throw new Error(`[buildInvoiceData] Service Order ${serviceOrderId} not found`);
    }

    const customerRecordId = soRecord['15']?.value ?? null;

    // 2. Query Customer record for primary address (confirmed FIDs):
    //   3=recordId, 6=firstName, 7=lastName, 8=email, 9=phone,
    //   66=primaryStreet1, 67=primaryStreet2, 68=primaryCity,
    //   69=primaryState, 70=primaryPostalCode, 71=primaryCountry
    let customerRecord = null;
    if (customerRecordId) {
        const customerResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
            from: TABLES.CUSTOMERS,
            select: [3, 6, 7, 8, 9, 66, 67, 68, 69, 70, 71],
            where: `{'3'.EX.'${String(customerRecordId).trim()}'}`
        }, { headers: qbHeaders });
        customerRecord = customerResponse?.data?.data?.[0] || null;
    }

    // 3. Query Invoice records for this Service Order (already written in Phase 3)
    const invoiceResponse = await axios.post(`${QB_API_ENDPOINT}/records/query`, {
        from: TABLES.INVOICES,
        select: [3, 6, 7, 8, 9, 10, 11, 12, 13, 15],
        where: `{'6'.EX.'${escapedId}'}`
    }, { headers: qbHeaders });
    const invoiceRecords = Array.isArray(invoiceResponse?.data?.data) ? invoiceResponse.data.data : [];

    // 4. Resolve job address and billing address
    // Service Order FID 163 = "Billing address same as primary address" (checkbox lookup)
    const billingSameAsPrimary = !!soRecord['163']?.value;

    // Job address sourced from Service Order FID 90 (location address lookup)
    const jobAddress = resolveAddressField(soRecord['90']?.value ?? null);

    // Customer primary address from Customer record (confirmed FIDs):
    //   66=street1, 67=street2, 68=city, 69=state, 70=postalCode, 71=country
    const customerPrimaryAddress = customerRecord ? {
        street1:     String(customerRecord['66']?.value ?? '').trim() || null,
        street2:     String(customerRecord['67']?.value ?? '').trim() || null,
        city:        String(customerRecord['68']?.value ?? '').trim() || null,
        state:       String(customerRecord['69']?.value ?? '').trim() || null,
        postalCode:  String(customerRecord['70']?.value ?? '').trim() || null,
        country:     String(customerRecord['71']?.value ?? '').trim() || null,
    } : null;

    // Billing address rule:
    //   FID 38 checked  → Customer Primary Address
    //   FID 38 unchecked → Job Location Address
    const billingAddress = billingSameAsPrimary ? customerPrimaryAddress : jobAddress;

    // 6. Build Invoice line items from queried Invoice records
    const lineItems = invoiceRecords.map(r => ({
        invoiceRecordId: String(r['3']?.value  ?? '').trim(),
        taskRecordId:    String(r['13']?.value ?? '').trim(),
        taskName:        String(r['7']?.value  ?? '').trim(),
        description:     String(r['8']?.value  ?? '').trim(),
        quantity:        r['9']?.value  ?? null,
        unitPrice:       r['10']?.value ?? null,
        lineStatus:      String(r['11']?.value ?? '').trim(),
        lineTotal:       r['12']?.value ?? null,
        sqFootage:       r['15']?.value ?? null,
    }));

    // 6. Financial summary — sourced from Service Order lookup fields
    const subtotal = soRecord['137']?.value ?? null;
    const taxAmount = soRecord['66']?.value ?? null;
    const totalAmount = soRecord['67']?.value ?? null;
    const discountAmount = soRecord['83']?.value ?? null;
    const hasDiscount = (parseFloat(discountAmount) || 0) > 0;
    const discountControlValue = String(soRecord['138']?.value ?? '').trim();
    const normalizedDiscountControlValue = discountControlValue.toLowerCase();
    const isMilitarySeniorDiscount = hasDiscount && (
        normalizedDiscountControlValue.includes('military') || normalizedDiscountControlValue.includes('senior')
    );
    const discountLabel = isMilitarySeniorDiscount
        ? 'Military / Senior Discount'
        : hasDiscount && normalizedDiscountControlValue.includes('other')
            ? 'Other Discount'
            : hasDiscount && discountControlValue
                ? (/discount/i.test(discountControlValue) ? discountControlValue : `${discountControlValue} Discount`)
                : 'Discount';
    const storedDiscountPercentage = parseFloat(soRecord['140']?.value) || 0;
    const discountPercentage = storedDiscountPercentage || (isMilitarySeniorDiscount ? 5 : null);
    const taxRate = getTaxRate(String(soRecord['105']?.value ?? ''));

    console.log('[buildInvoiceData] Resolved from Service Order.', {
        serviceOrderId,
        customerRecordId: customerRecordId ?? null,
        billingSameAsPrimary,
        rawFid90: soRecord['90']?.value ?? null,
        rawFid163: soRecord['163']?.value ?? null,
    });

    // 7. Assemble InvoiceData contract
    return {
        serviceOrder: {
            recordId:       String(soRecord['3']?.value  ?? '').trim(),
            jobNumber:      String(soRecord['3']?.value  ?? '').trim(),
            status:         String(soRecord['11']?.value ?? '').trim() || null,
            stage:          String(soRecord['40']?.value ?? '').trim() || null,
            serviceDate:    soRecord['9']?.value  ?? null,
            serviceType:    String(soRecord['10']?.value ?? '').trim() || null,
            serviceSubtype: String(soRecord['16']?.value ?? '').trim() || null,
            serviceNotes:   String(soRecord['73']?.value ?? '').trim() || null,
            cleanMaintenanceScheduledFor: soRecord['154']?.value ?? null,
            repairServicesScheduledFor:   soRecord['155']?.value ?? null,
        },
        customer: {
            recordId:      customerRecord ? String(customerRecord['3']?.value ?? '').trim() : null,
            firstName:     String(soRecord['93']?.value ?? '').trim() || null,
            lastName:      String(soRecord['94']?.value ?? '').trim() || null,
            phone:         String(soRecord['95']?.value ?? '').trim() || null,
            email:         String(soRecord['142']?.value ?? soRecord['57']?.value ?? '').trim() || null,
            primaryAddress: customerPrimaryAddress,
        },
        billingAddress,
        billingSameAsPrimary,
        jobAddress,
        invoiceMeta: {
            invoiceDate:    null, // TODO: populate when Invoice header date field is identified
            paymentTerms:   null, // TODO: populate from SO or Invoice header field
            dueDate:        null, // TODO: populate from SO or Invoice header field
        },
        financialSummary: {
            subtotal,
            discountAmount,
            discountLabel,
            discountPercentage,
            taxAmount,
            taxRate,
            total:      totalAmount,
            balanceDue: totalAmount, // TODO: subtract payments when payment records are available
        },
        lineItems,
        photos: selectedPhotos,
        payment:   null, // TODO: populate when payment records are available
        signature: null, // TODO: populate from SO digital signature field if present
    };
}

// --- SERVICE ORDER SUBMISSION ORCHESTRATION ---

/**
 * Determine which task blocks in the Tech Sheet would be split across printed
 * pages and inject explicit page-break-before rules so each block stays intact.
 * This avoids relying on Chromium's break-inside handling, which is unreliable
 * inside flex/grid containers and for large images.
 */
async function injectDeterministicPageBreaks(page) {
    // A4 content area with 0.5in margins at 96 CSS pixels per inch.
    const CONTENT_WIDTH_PX = 698;
    const CONTENT_HEIGHT_PX = 1026;

    await page.setViewport({
        width: CONTENT_WIDTH_PX,
        height: CONTENT_HEIGHT_PX,
        deviceScaleFactor: 1,
    });

    // Wait for fonts, images, and layout to fully settle before measuring.
    // This is critical because data-url images may decode asynchronously.
    await page.evaluate(async () => {
        await document.fonts.ready;
        const images = Array.from(document.images);
        await Promise.all(images.map(img => {
            if (img.complete) {
                return img.decode ? img.decode() : Promise.resolve();
            }
            return new Promise((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
            }).then(() => img.decode ? img.decode() : Promise.resolve());
        }));
        // Force a layout recalculation.
        document.body.offsetHeight;
    });

    // Extra beat to ensure any post-decode reflow has completed.
    await new Promise(resolve => setTimeout(resolve, 300));

    const getTaskBoxes = async () => {
        return page.evaluate(() => {
            return Array.from(document.querySelectorAll('[data-task-index]')).map(el => {
                const rect = el.getBoundingClientRect();
                return {
                    index: el.dataset.taskIndex,
                    top: rect.top,
                    height: rect.height,
                };
            });
        });
    };

    console.log('[injectDeterministicPageBreaks] Starting pagination analysis.');
    console.log('[injectDeterministicPageBreaks] Printable page height (px):', CONTENT_HEIGHT_PX);

    const initialBoxes = await getTaskBoxes();
    console.log('[injectDeterministicPageBreaks] Measured task blocks:', initialBoxes.length);
    console.log('[injectDeterministicPageBreaks] Task block measurements:', initialBoxes.map(b => ({ index: b.index, top: b.top, height: b.height })));

    if (!initialBoxes || initialBoxes.length === 0) {
        return;
    }

    const breaks = new Set();

    for (let iteration = 0; iteration < 5; iteration++) {
        let changed = false;
        let accumulatedShift = 0;

        for (const box of initialBoxes) {
            const adjustedTop = box.top + accumulatedShift;
            const adjustedBottom = adjustedTop + box.height;
            const pageIndex = Math.floor(adjustedTop / CONTENT_HEIGHT_PX);
            const pageStart = pageIndex * CONTENT_HEIGHT_PX;
            const pageContentEnd = (pageIndex + 1) * CONTENT_HEIGHT_PX;
            const remainingSpace = pageContentEnd - adjustedTop;
            const crossesBoundary = adjustedBottom > pageContentEnd + 0.5;
            const fitsOnOnePage = box.height <= CONTENT_HEIGHT_PX + 0.5;

            let decision = 'KEEP';
            let reason = '';
            const expression = `crossesBoundary(${crossesBoundary}) && fitsOnOnePage(${fitsOnOnePage}) && !alreadyBreaking(${breaks.has(box.index)})`;

            if (crossesBoundary && fitsOnOnePage && !breaks.has(box.index)) {
                breaks.add(box.index);
                changed = true;
                decision = 'BREAK';
                reason = 'task crosses page boundary and fits on one page';
            } else if (crossesBoundary && !fitsOnOnePage) {
                reason = 'task crosses page boundary but is larger than one printable page; cannot keep intact';
            } else if (breaks.has(box.index)) {
                reason = 'task already marked for break';
            } else if (crossesBoundary) {
                reason = 'task crosses boundary but is already scheduled for break';
            } else {
                reason = 'task fits within current printable page';
            }

            console.log(`[injectDeterministicPageBreaks] Task ${box.index}: top=${adjustedTop.toFixed(1)}, height=${box.height.toFixed(1)}, page=${pageIndex}, pageStart=${pageStart.toFixed(1)}, pageEnd=${pageContentEnd.toFixed(1)}, remaining=${remainingSpace.toFixed(1)}, crosses=${crossesBoundary}, fits=${fitsOnOnePage}, decision=${decision}, expression="${expression}", reason="${reason}"`);

            if (breaks.has(box.index)) {
                // Simulate the effect of breaking before this block: it will start
                // at the top of the next page's content area.
                const nextPageContentStart = (pageIndex + 1) * CONTENT_HEIGHT_PX;
                const shift = nextPageContentStart - adjustedTop;
                accumulatedShift += shift;
            }
        }

        if (!changed) break;
    }

    if (breaks.size > 0) {
        const css = Array.from(breaks)
            .map(idx => `[data-task-index="${idx}"] { page-break-before: always !important; break-before: page !important; }`)
            .join('\n');
        await page.addStyleTag({ content: css });
        console.log('[injectDeterministicPageBreaks] Injected CSS:', css);
        console.log('[SubmitServiceOrder] Injected deterministic page breaks for task indexes:', Array.from(breaks));
    } else {
        console.log('[injectDeterministicPageBreaks] No page breaks needed; all task blocks fit.');
    }
}

async function getSubmittedPhotoBuffer(photo) {
    const source = String(photo?.dataUrl || '').trim();
    if (!source) {
        throw new Error('Submitted photo is missing Firebase Storage content');
    }
    if (source.startsWith('data:image/')) {
        const base64 = source.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
        return Buffer.from(base64, 'base64');
    }

    const photoUrl = new URL(source);
    if (photoUrl.hostname !== 'firebasestorage.googleapis.com') {
        throw new Error('Submitted photo must use a Firebase Storage URL');
    }
    const response = await axios.get(photoUrl.toString(), {
        responseType: 'arraybuffer',
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024,
    });
    return Buffer.from(response.data);
}

async function updateSubmittedJobPhotos(serviceOrderId, jobPhotos) {
    if (!Array.isArray(jobPhotos) || jobPhotos.length === 0) {
        return { createdRecordIds: [], updatedRecordIds: [] };
    }

    const createdRecordIds = [];
    const updates = [];
    for (const photo of jobPhotos) {
        const slot = String(photo?.slot || '').trim().toLowerCase();
        const taskId = String(photo?.taskId || '').trim();
        const taskName = String(photo?.taskName || '').trim();
        const recordId = String(photo?.quickbaseRecordId || '').trim();
        const fileName = String(photo?.fileName || '').trim();
        const isExistingQuickbaseRecord = photo?.isExistingQuickbaseRecord === true;
        console.log('[SubmitServiceOrder][JobPhotoUpdate]', {
            serviceOrderId,
            taskId,
            slot,
            quickbaseRecordId: recordId || null,
            fileName,
            isExistingQuickbaseRecord,
        });
        if ((slot !== 'before' && slot !== 'after') || !taskId || !taskName || !fileName) {
            throw new Error('Submitted photo is missing a valid task, task name, before/after slot, or filename');
        }

        const caption = String(photo?.notes || '').trim();
        const photoNotes = `${slot === 'before' ? 'Before' : 'After'}:${caption ? ` ${caption}` : ''}`;
        const numericRecordId = Number.parseInt(recordId, 10);
        if (Number.isFinite(numericRecordId)) {
            updates.push({
                3: { value: numericRecordId },
                11: { value: 'Service Order' },
                7: { value: photoNotes }
            });
            continue;
        }

        const photoBuffer = await getSubmittedPhotoBuffer(photo);
        if (photoBuffer.length === 0) {
            throw new Error(`Submitted ${slot} photo ${fileName} is empty`);
        }
        const createResponse = await axios.post(`${QB_API_ENDPOINT}/records`, {
            to: TABLES.JOB_PHOTOS,
            data: [{
                6: { value: taskName },
                7: { value: photoNotes },
                8: { value: { fileName, data: photoBuffer.toString('base64') } },
                9: { value: Number.parseInt(serviceOrderId, 10) },
                11: { value: 'Service Order' },
            }],
            fieldsToReturn: [3],
        }, { headers: buildQuickbaseHeaders() });
        const createdRecordId = String(createResponse?.data?.data?.[0]?.['3']?.value || '').trim();
        if (!createdRecordId) {
            throw new Error(`QuickBase did not return a Job Photo record ID for ${fileName}`);
        }
        createdRecordIds.push(createdRecordId);
    }

    if (updates.length > 0) {
        await writeQuickbaseRecords(TABLES.JOB_PHOTOS, updates, [3, 7, 11]);
    }
    return {
        createdRecordIds,
        updatedRecordIds: updates.map((update) => String(update[3].value)),
    };
}

async function updateCompletedTaskNotes(techSheetData) {
    const completedTasks = Array.isArray(techSheetData?.tasks)
        ? techSheetData.tasks.filter((task) => task?.isFinished === true)
        : [];
    if (completedTasks.length === 0) {
        return 0;
    }

    const technicianName = String(techSheetData?.leadTechnicianName || '').trim();
    if (!technicianName) {
        throw new Error('Lead technician name is required to update completed task notes');
    }
    const updates = completedTasks.map((task) => {
        const taskId = Number.parseInt(String(task?.id || ''), 10);
        if (!Number.isFinite(taskId)) {
            throw new Error('Completed task is missing a valid record ID');
        }
        const technicianNote = String(task?.technicianNote || '').trim();
        return {
            3: { value: taskId },
            41: { value: technicianNote ? `${technicianName}\n${technicianNote}` : technicianName }
        };
    });

    await writeQuickbaseRecords(TABLES.SERVICE_ORDER_TASKS, updates, [3, 41]);
    return updates.length;
}

async function sendTechSheetEmail(invoiceData, techSheetFilename, techSheetPdfBuffer) {
    const recipient = String(invoiceData?.customer?.email || '').trim();
    if (!recipient) {
        throw new Error('Service Order customer email is required to send the Tech Sheet');
    }
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        throw new Error('Email credentials are not configured');
    }

    const transporter = nodemailer.createTransport({
        host: 'smtp.ionos.com',
        port: 465,
        secure: true,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    const customerName = [invoiceData?.customer?.firstName, invoiceData?.customer?.lastName]
        .filter(Boolean)
        .join(' ') || 'Customer';
    await transporter.sendMail({
        from: `"The Roof Medic" <${process.env.EMAIL_USER}>`,
        to: recipient,
        subject: 'Your Roof Medic Tech Sheet',
        html: `<p>Dear ${customerName},</p><p>Attached is the Tech Sheet for your completed service.</p><p>Sincerely,<br><strong>The Roof Medic</strong></p>`,
        attachments: [{ filename: techSheetFilename, content: techSheetPdfBuffer }]
    });
}

app.post('/service-order/submit', async (req, res) => {
    const { techSheetData, serviceOrderPayload } = req.body || {};

    // --- Validation ---
    const serviceOrderId = String(techSheetData?.serviceOrderId || '').trim();
    if (!serviceOrderId) {
        return res.status(400).json({ success: false, message: 'techSheetData.serviceOrderId is required' });
    }
    if (!techSheetData) {
        return res.status(400).json({ success: false, message: 'techSheetData is required' });
    }

    console.log('[SubmitServiceOrder] Submission received.', {
        serviceOrderId,
        customerName: techSheetData.customerName,
        taskCount: techSheetData.tasks?.length ?? 0,
        selectedPhotoCount: techSheetData.selectedPhotos?.length ?? 0,
        jobPhotoCount: techSheetData.jobPhotos?.length ?? 0,
        hasServiceOrderPayload: !!serviceOrderPayload,
    });

    // Use the server timestamp at request receipt as the authoritative
    // successful Wrap-Up submission time.
    const wrapUpCompletedAt = new Date().toISOString();
    if (techSheetData && typeof techSheetData === 'object') {
        techSheetData.wrapUpCompletedAt = wrapUpCompletedAt;
    }

    // --- Phase 1: Tech Sheet PDF Generation ---
    const writeDebugArtifacts = process.env.WRITE_PDF_DEBUG_ARTIFACTS === 'true';
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (writeDebugArtifacts && !fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
    let browser = null;
    try {
        const htmlContent = await generateTechSheetHtml(techSheetData);
        console.log('[SubmitServiceOrder] Tech Sheet HTML generated, length:', htmlContent.length);

        const executablePath =
            process.env.FUNCTIONS_EMULATOR === 'true'
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            : await chromium.executablePath();

        browser = await puppeteer.launch({
            executablePath,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });

        const page = await browser.newPage();
        // Set the viewport to the PDF content size before loading HTML so the
        // initial layout matches the printable area.
        await page.setViewport({ width: 698, height: 1026, deviceScaleFactor: 1 });
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        // Apply deterministic pagination so each task block stays intact.
        console.log('[SubmitServiceOrder] Applying deterministic pagination to Tech Sheet.');
        await injectDeterministicPageBreaks(page);

        const techSheetPdfResult = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
            displayHeaderFooter: true,
            footerTemplate: `<div style="font-size: 9px; width: 100%; padding: 0 0.5in; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box;">
                <span style="color: #555;">The Roof Medic &bull; 6519 Myers Rd E Unit 3, Bonney Lake, WA 98391 &bull; 253-862-4412 &bull; contact@YourRoofMedic.com</span>
                <span style="color: #555;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
            </div>`,
        });
        const techSheetPdfBuffer = Buffer.from(techSheetPdfResult);
        const techSheetFilename = `TechSheet_${serviceOrderId}.pdf`;

        console.log('[SubmitServiceOrder] Tech Sheet PDF generated.', {
            serviceOrderId,
            techSheetFilename,
            techSheetPdfSize: techSheetPdfBuffer.length,
        });

        // --- DEV ONLY: Write Tech Sheet PDF and HTML to tmp for visual validation ---
        if (writeDebugArtifacts) {
            const techSheetTmpPath = path.join(tmpDir, techSheetFilename);
            fs.writeFileSync(techSheetTmpPath, techSheetPdfBuffer);
            console.log('[SubmitServiceOrder] Tech Sheet PDF written to disk.', {
                serviceOrderId,
                techSheetTmpPath,
            });

            // Also write the generated HTML so pagination decisions can be inspected.
            const techSheetHtmlTmpPath = path.join(tmpDir, `TechSheet_${serviceOrderId}.html`);
            fs.writeFileSync(techSheetHtmlTmpPath, htmlContent);
            console.log('[SubmitServiceOrder] Tech Sheet HTML written to disk.', {
                serviceOrderId,
                techSheetHtmlTmpPath,
            });
        }

        // --- Phase 2: Read completed Service Order Tasks and build Invoice line model ---
        const taskRecords = await fetchServiceOrderTasksForInvoice(serviceOrderId);
        const invoiceLineItems = buildInvoiceLineItems(taskRecords);

        console.log('[SubmitServiceOrder] Invoice line model assembled.', {
            serviceOrderId,
            totalLines: invoiceLineItems.length,
            cancelledLines: invoiceLineItems.filter(l => l.lineStatus === 'Cancelled').length,
            invoiceLineItems,
        });

        // --- Phase 3: Upsert Invoice records in Invoices table (bt73v82ts) ---
        const invoiceWriteResult = await writeInvoiceLineItems(serviceOrderId, invoiceLineItems);

        console.log('[SubmitServiceOrder] Invoice records upsert complete.', {
            serviceOrderId,
            ...invoiceWriteResult,
        });
        // --- Phase 3.5: Build InvoiceData contract from persisted QuickBase data ---
        const invoiceData = await buildInvoiceData(serviceOrderId, techSheetData?.selectedPhotos || []);

        console.log('[InvoiceData]', JSON.stringify(invoiceData, null, 2));

        // --- Phase 4 (Validation Only): Generate Invoice PDF ---
        const invoiceHtml = await generateInvoiceHtml(invoiceData);
        console.log('[SubmitServiceOrder] Invoice HTML generated, length:', invoiceHtml.length);

        const invoicePrintTimestamp = new Date().toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles',
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
        });

        const invoicePage = await browser.newPage();
        await invoicePage.setContent(invoiceHtml, { waitUntil: 'networkidle0' });
        const invoicePdfResult = await invoicePage.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
            displayHeaderFooter: true,
            footerTemplate: `<div style="font-size: 9px; width: 100%; padding: 0 0.5in; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box;">
                <span style="color: #555;">Printed ${invoicePrintTimestamp}</span>
                <span style="color: #555;">The Roof Medic &bull; 6519 Myers Rd E Unit 3, Bonney Lake, WA 98391 &bull; 253-862-4412 &bull; contact@YourRoofMedic.com</span>
                <span style="color: #555;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
            </div>`,
        });
        const invoicePdfBuffer = Buffer.from(invoicePdfResult);
        await invoicePage.close();

        console.log('[SubmitServiceOrder] Invoice PDF generated (validation only).', {
            serviceOrderId,
            invoiceHtmlLength: invoiceHtml.length,
            invoicePdfSize: invoicePdfBuffer.length,
        });

        // --- DEV ONLY: Write Invoice PDF to tmp for visual validation ---
        const invoiceFilename = `Invoice_${serviceOrderId}.pdf`;
        if (writeDebugArtifacts) {
            const invoiceTmpPath = path.join(tmpDir, invoiceFilename);
            fs.writeFileSync(invoiceTmpPath, invoicePdfBuffer);
            console.log('[SubmitServiceOrder] Invoice PDF written to disk.', {
                serviceOrderId,
                invoiceTmpPath,
            });
        }

        // TODO Phase 4: Generate Invoice PDF from the created Invoice records
        // TODO Phase 5: Assemble complete Service Order payload
        // TODO Phase 6: Update parent Service Order record
        // TODO Phase 7: Attach PDFs
        // TODO Phase 8: Email Tech Sheet
        // TODO Phase 9: Schedule Review Request
        // TODO Phase 10: Cleanup

        const normalizedServiceOrderId = Number.parseInt(serviceOrderId, 10);
        const actualEndDate = invoiceData?.serviceOrder?.serviceDate;
        if (!Number.isFinite(normalizedServiceOrderId)) {
            throw new Error('Service Order record ID must be numeric');
        }
        if (!actualEndDate) {
            throw new Error('Completed service date is required to update Actual End Date');
        }

        console.log('[SubmitServiceOrder][TechSheetUploadBuffer]', {
            exists: !!techSheetPdfBuffer,
            isBuffer: Buffer.isBuffer(techSheetPdfBuffer),
            length: techSheetPdfBuffer?.length ?? null,
            type: typeof techSheetPdfBuffer,
        });
        await uploadQuickbasePdfAttachment(serviceOrderId, 160, techSheetFilename, techSheetPdfBuffer);
        console.log('[SubmitServiceOrder][InvoiceUploadBuffer]', {
            exists: !!invoicePdfBuffer,
            isBuffer: Buffer.isBuffer(invoicePdfBuffer),
            length: invoicePdfBuffer?.length ?? null,
            type: typeof invoicePdfBuffer,
        });
        await uploadQuickbasePdfAttachment(serviceOrderId, 159, invoiceFilename, invoicePdfBuffer);
        await writeQuickbaseRecords(TABLES.SERVICE_ORDERS, [{
            3: { value: normalizedServiceOrderId },
            73: { value: String(serviceOrderPayload?.technicianTaskNotes || '').trim() },
            65: { value: actualEndDate }
        }], [3, 65, 73]);
        const photoUpdateCount = await updateSubmittedJobPhotos(serviceOrderId, techSheetData.jobPhotos);
        const taskUpdateCount = await updateCompletedTaskNotes(techSheetData);
        await writeQuickbaseRecords(TABLES.SERVICE_ORDERS, [{
            3: { value: normalizedServiceOrderId },
            11: { value: 'Invoice Review' }
        }], [3, 11]);
        await sendTechSheetEmail(invoiceData, techSheetFilename, techSheetPdfBuffer);

        return res.status(200).json({
            success: true,
            serviceOrderId,
            production: {
                techSheetUploaded: true,
                invoiceUploaded: true,
                serviceOrderUpdated: true,
                photoUpdateCount,
                taskUpdateCount,
                status: 'Invoice Review',
                techSheetEmailSent: true
            }
        });
    } catch (error) {
        console.error('[SubmitServiceOrder] Orchestration failed:', error.message);
        return res.status(500).json({ success: false, message: 'Service Order submission failed' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// --- DEPLOYMENT VERIFICATION ENDPOINT ---
app.get('/verify-deploy', (req, res) => {
    res.status(200).send('DEPLOYMENT_ACTIVE_2026_06_12_10AM');
});

exports.apiV2 = onRequest(
    {
        memory: '1GiB',
        timeoutSeconds: 120,
        secrets: [googleMapsApiKey, rcClientId, rcClientSecret, rcJwt, pipelineSecret]
    },
    app
);
