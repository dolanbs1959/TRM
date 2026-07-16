const path = require('path');
const fs = require('fs');
const { resizePhotoForPdf } = require('./pdfGenerator');

const companyConfig = {
    name: 'The Roof Medic',
    address: '6519 Myers Rd E Unit 3, Bonney Lake, WA 98391',
    phone: '253-862-4412',
    email: 'contact@YourRoofMedic.com',
    logoPath: path.join(__dirname, '../src/assets/TRM_logo.png'),
};

function formatYesNo(value) {
    if (value === 'yes') return 'Yes';
    if (value === 'no') return 'No';
    if (value === 'na') return 'N/A';
    return '—';
}

function formatTimestamp(isoString) {
    if (!isoString) return '—';
    try {
        return new Date(isoString).toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles',
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
        });
    } catch {
        return isoString;
    }
}

function getLogoDataUrl() {
    try {
        const buffer = fs.readFileSync(companyConfig.logoPath);
        return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
        return '';
    }
}

function buildCrewSectionHtml(techSheetData) {
    const { leadTechnicianName, crewMembers, earliestArrivalAt, wrapUpCompletedAt } = techSheetData;

    const crewRows = crewMembers.length > 0
        ? crewMembers.map(m => `
            <tr>
                <td>${m.technicianName || '—'}</td>
                <td>${m.assignmentStatus || '—'}</td>
                <td>${m.arrivedAt ? formatTimestamp(m.arrivedAt) : '—'}</td>
            </tr>`).join('')
        : '<tr><td colspan="3" style="color:#888;">No crew assignments recorded.</td></tr>';

    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Crew Summary</h3>
            <div class="ts-detail-grid">
                <div class="ts-detail-item">
                    <span class="ts-detail-label">Lead Technician</span>
                    <span class="ts-detail-value">${leadTechnicianName || '—'}</span>
                </div>
                <div class="ts-detail-item">
                    <span class="ts-detail-label">Job Start (Earliest Arrival)</span>
                    <span class="ts-detail-value">${formatTimestamp(earliestArrivalAt)}</span>
                </div>
                <div class="ts-detail-item">
                    <span class="ts-detail-label">Wrap-Up Completed</span>
                    <span class="ts-detail-value">${formatTimestamp(wrapUpCompletedAt)}</span>
                </div>
            </div>
            <table class="ts-table" style="margin-top:12px;">
                <thead>
                    <tr><th>Technician</th><th>Assignment Status</th><th>Arrived At</th></tr>
                </thead>
                <tbody>${crewRows}</tbody>
            </table>
        </section>`;
}

function buildNoteBox(label, value) {
    const content = value || 'None';
    return `<div class="ts-notes-box"><strong>${label}</strong> ${content}</div>`;
}

function buildInspectionSummaryHtml(f) {
    const customerServiceRows = [
        ['Customer Home On Arrival',      f.customerHomeOnArrival],
        ['Customer Home On Departure',    f.customerHomeOnDeparture],
        ['Customer Walked Around Home',   f.customerWalkedAround],
        ['Photos Taken',                  f.photosTaken],
        ['All Windows Closed On Home',    f.allWindowsClosed],
        ['Vehicles Moved Away From Home', f.vehiclesMovedAway],
    ];
    const prepRows = [
        ['Moved Flower Beds',               f.movedFlowerBeds],
        ['Moved Patio Furniture',           f.movedPatioFurniture],
        ['Moved Flowers / Hanging Baskets', f.movedFlowersHangingBaskets],
        ['Moved Misc Outdoor Items',        f.movedMiscOutdoorItems],
        ['Moved Shrubs / Hedges / Trees',   f.movedShrubsHedgesTrees],
        ['Hoses Ran Along Concrete',        f.hosesRanAlongConcrete],
    ];
    const serviceRows = [
        ['Roof Cleared of Debris',            f.roofClearedOfDebris],
        ['All Gutters & Downspouts Cleared',  f.allGuttersDownspoutsCleared],
        ['All Included Roofs Serviced',       f.allIncludedRoofsServiced],
        ['Plants Rinsed Before Treatment',    f.plantsRinsedBeforeTreatment],
        ['Plants Rinsed After Treatment',     f.plantsRinsedAfterTreatment],
    ];
    const cleanupRows = [
        ['Rinsed Windows',              f.rinsedWindows],
        ['Rinsed Siding',               f.rinsedSiding],
        ['Rinsed Fascia & Soffits',     f.rinsedFasciaSoffits],
        ['Rinsed Gutters',              f.rinsedGutters],
        ['Cleared Decks / Patios',      f.clearedDecksPatios],
        ['Cleared Window Ledges',       f.clearedWindowLedges],
        ['Cleared Flower Beds',         f.clearedFlowerBeds],
        ['Cleared Shrubs / Hedges',     f.clearedShrubsHedgesTrees],
        ['Cleared Patio Furniture',     f.clearedPatioFurniture],
        ['Cleared Fence Line',          f.clearedFenceLine],
        ["Cleared Neighbors' Yards",    f.clearedNeighborsYards],
        ['All Gates Closed',            f.allGatesClosed],
    ];

    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Inspection Summary</h3>
            <div class="ts-two-column">
                <div class="ts-column">
                    <div class="ts-subsection">
                        <h4 class="ts-subsection-title">Customer Service</h4>
                        ${buildChecklistTable(customerServiceRows)}
                    </div>
                    <div class="ts-subsection">
                        <h4 class="ts-subsection-title">Pre-Service Preparation</h4>
                        ${buildChecklistTable(prepRows)}
                        ${buildNoteBox('Prep Notes:', f.prepNotes)}
                    </div>
                </div>
                <div class="ts-column">
                    <div class="ts-subsection">
                        <h4 class="ts-subsection-title">Service Checklist</h4>
                        ${buildChecklistTable(serviceRows)}
                    </div>
                    <div class="ts-subsection">
                        <h4 class="ts-subsection-title">Post-Service Cleanup</h4>
                        ${buildChecklistTable(cleanupRows)}
                        ${buildNoteBox('Cleanup Notes:', f.cleanupNotes)}
                    </div>
                </div>
            </div>
        </section>`;
}

function buildPhotoHtml(photo) {
    const imgTag = photo.resizedSrc
        ? `<img src="${photo.resizedSrc}" alt="${photo.slot === 'before' ? 'Before' : 'After'} photo" class="ts-photo-img">`
        : `<div class="ts-photo-missing">Photo unavailable</div>`;
    return `
        <div class="ts-photo">
            ${imgTag}
            <div class="ts-photo-notes"><strong>Photo Notes:</strong> ${photo.notes || 'None'}</div>
        </div>`;
}

async function buildServicesPerformedHtml(tasks, servicesCompletedNotes, selectedPhotos) {
    if (!tasks || tasks.length === 0) {
        return `
            <section class="ts-section">
                <h3 class="ts-section-title">Services Performed</h3>
                <p class="ts-empty-text">No service tasks assigned.</p>
            </section>`;
    }

    const resizedPhotos = await Promise.all((selectedPhotos || []).map(async p => {
        const src = p.dataUrl || '';
        if (!src) return { ...p, resizedSrc: '' };
        try {
            const resizedSrc = await resizePhotoForPdf(src, 800);
            return { ...p, resizedSrc };
        } catch (error) {
            console.error('[TechSheet] Photo resize failed:', error.message);
            return { ...p, resizedSrc: src };
        }
    }));

    const photosByTaskId = {};
    resizedPhotos.forEach(p => {
        const key = p.taskId || '';
        if (!photosByTaskId[key]) photosByTaskId[key] = [];
        photosByTaskId[key].push(p);
    });

    const taskCards = tasks.map((t, index) => {
        const taskPhotos = photosByTaskId[t.id] || [];
        const beforePhotos = taskPhotos.filter(p => p.slot === 'before');
        const afterPhotos = taskPhotos.filter(p => p.slot === 'after');

        const beforeHtml = beforePhotos.length > 0
            ? beforePhotos.map(p => buildPhotoHtml(p)).join('')
            : `<p class="ts-empty-text">No before photos.</p>`;
        const afterHtml = afterPhotos.length > 0
            ? afterPhotos.map(p => buildPhotoHtml(p)).join('')
            : `<p class="ts-empty-text">No after photos.</p>`;

        // Only mark subsequent task cards for measurement; the first task is
        // measured through its parent .ts-task-group-start wrapper.
        const dataAttr = index > 0 ? ` data-task-index="${index + 1}"` : '';

        return `
            <div class="ts-task-card"${dataAttr}>
                <h4 class="ts-task-name">${t.taskName || '—'}</h4>
                ${t.description ? `<div class="ts-task-description">${t.description}</div>` : ''}
                <div class="ts-task-info">
                    <span class="ts-info-label">Category</span>
                    <span class="ts-info-value">${t.serviceCategory || '—'}</span>
                    <span class="ts-info-label">Quantity</span>
                    <span class="ts-info-value">${t.quantity != null ? t.quantity : '—'}</span>
                </div>
                ${buildNoteBox('Tech Notes:', t.technicianNote)}
                <div class="ts-task-photos">
                    <div class="ts-photo-column">
                        <h5 class="ts-photo-title">Before</h5>
                        ${beforeHtml}
                    </div>
                    <div class="ts-photo-column">
                        <h5 class="ts-photo-title">After</h5>
                        ${afterHtml}
                    </div>
                </div>
            </div>`;
    });

    const firstTask = taskCards[0] || '';
    const remainingTasks = taskCards.slice(1).join('');

    return `
        <section class="ts-section ts-section--tasks">
            <div class="ts-task-group-start" data-task-index="0">
                <h3 class="ts-section-title">Services Performed</h3>
                ${firstTask}
            </div>
            ${remainingTasks}
            ${buildNoteBox('Additional Notes:', servicesCompletedNotes)}
        </section>`;
}

function buildChecklistTable(rows) {
    const tableRows = rows.map(([label, value]) => `
        <tr>
            <td class="ts-checklist-label">${label}</td>
            <td class="ts-checklist-value ts-checklist-value--${value || 'empty'}">${formatYesNo(value)}</td>
        </tr>`).join('');
    return `
        <table class="ts-table ts-checklist-table">
            <tbody>${tableRows}</tbody>
        </table>`;
}

async function generateTechSheetHtml(techSheetData) {
    const {
        serviceOrderId,
        jobNumber,
        customerName,
        serviceAddress,
        locationName,
        wrapUpForm,
        tasks,
        selectedPhotos,
    } = techSheetData;

    const logoDataUrl = getLogoDataUrl();
    const logoHtml = logoDataUrl
        ? `<img src="${logoDataUrl}" alt="${companyConfig.name}" class="ts-logo">`
        : `<span class="ts-logo-text">${companyConfig.name}</span>`;

    const servicesPerformedHtml = await buildServicesPerformedHtml(
        tasks,
        wrapUpForm.servicesCompletedNotes,
        selectedPhotos
    );

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tech Sheet — Service Order #${serviceOrderId}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; background: #fff; padding: 0; }
  .ts-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #c0392b; padding-bottom: 16px; margin-bottom: 24px; }
  .ts-logo { max-height: 60px; }
  .ts-logo-text { font-size: 22px; font-weight: bold; color: #c0392b; }
  .ts-header-info { text-align: right; }
  .ts-header-info h1 { font-size: 20px; color: #c0392b; margin-bottom: 4px; }
  .ts-header-info p { font-size: 12px; color: #555; line-height: 1.5; }
  .ts-section { margin-bottom: 22px; }
  .ts-section-title { font-size: 15px; font-weight: bold; color: #c0392b; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; margin-bottom: 10px; }
  .ts-detail-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .ts-detail-item { background: #f9f9f9; padding: 8px 10px; border-left: 3px solid #c0392b; }
  .ts-detail-label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
  .ts-detail-value { display: block; font-size: 13px; font-weight: bold; color: #222; }
  .ts-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .ts-table th { background: #c0392b; color: #fff; padding: 6px 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .ts-table td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .ts-table tr:nth-child(even) td { background: #fafafa; }
  .ts-checklist-table td { padding: 5px 8px; }
  .ts-checklist-label { width: 60%; color: #444; }
  .ts-checklist-value { font-weight: bold; }
  .ts-checklist-value--yes { color: #27ae60; }
  .ts-checklist-value--no { color: #c0392b; }
  .ts-checklist-value--na { color: #888; }
  .ts-checklist-value--empty { color: #bbb; }
  .ts-notes-box { font-size: 12px; color: #444; line-height: 1.6; background: #f9f9f9; padding: 8px 10px; border-left: 3px solid #c0392b; margin-top: 8px; }
  .ts-empty-text { color: #888; font-size: 12px; font-style: italic; margin: 4px 0; }
  .ts-two-column { display: flex; gap: 20px; }
  .ts-column { flex: 1; min-width: 0; }
  .ts-subsection { margin-bottom: 16px; }
  .ts-subsection:last-child { margin-bottom: 0; }
  .ts-subsection-title { font-size: 13px; font-weight: bold; color: #444; margin-bottom: 6px; }
  .ts-section--tasks { break-before: auto; }
  .ts-task-group-start { page-break-inside: avoid; break-inside: avoid; }
  .ts-task-card { border: 1px solid #e0e0e0; padding: 14px; margin-bottom: 16px; page-break-inside: avoid; break-inside: avoid; }
  .ts-photo { margin-bottom: 12px; page-break-inside: avoid; break-inside: avoid; }
  .ts-task-name { font-size: 15px; font-weight: bold; color: #c0392b; margin-bottom: 6px; }
  .ts-task-description { font-size: 12px; color: #444; margin-bottom: 10px; line-height: 1.4; }
  .ts-task-info { display: grid; grid-template-columns: 90px 1fr; gap: 4px 10px; margin-bottom: 10px; font-size: 12px; }
  .ts-info-label { font-weight: bold; color: #555; }
  .ts-info-value { color: #222; }
  .ts-task-photos { display: flex; gap: 16px; margin-top: 12px; }
  .ts-photo-column { flex: 1; min-width: 0; }
  .ts-photo-title { font-size: 12px; font-weight: bold; color: #444; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .ts-photo-img { max-width: 2.75in; max-height: 4in; width: auto; height: auto; border: 1px solid #ddd; display: block; }
  .ts-photo-missing { background: #f5f5f5; border: 1px dashed #ccc; padding: 20px; text-align: center; color: #888; font-size: 12px; }
  .ts-photo-notes { font-size: 11px; color: #555; margin-top: 4px; line-height: 1.4; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>

<div class="ts-header">
  ${logoHtml}
  <div class="ts-header-info">
    <h1>Tech Sheet</h1>
    <p><strong>Job #:</strong> ${jobNumber || serviceOrderId || '—'}</p>
    <p>${customerName || '—'}</p>
    <p>${locationName || serviceAddress || '—'}</p>
    <p>${serviceAddress || '—'}</p>
  </div>
</div>

${buildCrewSectionHtml(techSheetData)}
${buildInspectionSummaryHtml(wrapUpForm)}
${servicesPerformedHtml}

</body>
</html>`;

    return html;
}

module.exports = { generateTechSheetHtml };
