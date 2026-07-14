const path = require('path');
const fs = require('fs');

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

function buildCustomerServiceSectionHtml(f) {
    const rows = [
        ['Customer Home On Arrival',      f.customerHomeOnArrival],
        ['Customer Home On Departure',    f.customerHomeOnDeparture],
        ['Customer Walked Around Home',   f.customerWalkedAround],
        ['Photos Taken',                  f.photosTaken],
        ['All Windows Closed On Home',    f.allWindowsClosed],
        ['Vehicles Moved Away From Home', f.vehiclesMovedAway],
    ];
    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Customer Service</h3>
            ${buildChecklistTable(rows)}
        </section>`;
}

function buildPrepSectionHtml(f) {
    const rows = [
        ['Moved Flower Beds',               f.movedFlowerBeds],
        ['Moved Patio Furniture',           f.movedPatioFurniture],
        ['Moved Flowers / Hanging Baskets', f.movedFlowersHangingBaskets],
        ['Moved Misc Outdoor Items',        f.movedMiscOutdoorItems],
        ['Moved Shrubs / Hedges / Trees',   f.movedShrubsHedgesTrees],
        ['Hoses Ran Along Concrete',        f.hosesRanAlongConcrete],
    ];
    const notesHtml = f.prepNotes
        ? `<p class="ts-notes-text"><strong>Prep Notes:</strong> ${f.prepNotes}</p>`
        : '';
    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Pre-Service Preparation</h3>
            ${buildChecklistTable(rows)}
            ${notesHtml}
        </section>`;
}

function buildServiceChecklistSectionHtml(f) {
    const rows = [
        ['Roof Cleared of Debris',            f.roofClearedOfDebris],
        ['All Gutters & Downspouts Cleared',  f.allGuttersDownspoutsCleared],
        ['All Included Roofs Serviced',       f.allIncludedRoofsServiced],
        ['Plants Rinsed Before Treatment',    f.plantsRinsedBeforeTreatment],
        ['Plants Rinsed After Treatment',     f.plantsRinsedAfterTreatment],
    ];
    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Service Checklist</h3>
            ${buildChecklistTable(rows)}
        </section>`;
}

function buildCleanupSectionHtml(f) {
    const rows = [
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
    const notesHtml = f.cleanupNotes
        ? `<p class="ts-notes-text"><strong>Cleanup Notes:</strong> ${f.cleanupNotes}</p>`
        : '';
    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Post-Service Cleanup</h3>
            ${buildChecklistTable(rows)}
            ${notesHtml}
        </section>`;
}

function buildTasksSectionHtml(tasks, servicesCompletedNotes, allServicesCompleted) {
    const statusBadge = allServicesCompleted
        ? '<span class="ts-badge ts-badge--complete">All Services Completed</span>'
        : '<span class="ts-badge ts-badge--incomplete">Pending Completion</span>';

    const taskRows = tasks.length > 0
        ? tasks.map(t => {
            const finishedClass = t.isFinished ? 'ts-task-row--finished' : '';
            const icon = t.isFinished ? '&#10003;' : '&#9675;';
            const qtyCell = t.quantity != null ? `Qty: ${t.quantity}` : '—';
            const noteCell = t.technicianNote || '—';
            return `
                <tr class="${finishedClass}">
                    <td class="ts-task-icon">${icon}</td>
                    <td>${t.taskName || '—'}</td>
                    <td>${t.serviceCategory || '—'}</td>
                    <td>${qtyCell}</td>
                    <td>${noteCell}</td>
                </tr>`;
        }).join('')
        : '<tr><td colspan="5" style="color:#888;">No service tasks assigned.</td></tr>';

    const notesHtml = servicesCompletedNotes
        ? `<p class="ts-notes-text" style="margin-top:10px;"><strong>Additional Notes:</strong> ${servicesCompletedNotes}</p>`
        : '';

    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Ordered Services ${statusBadge}</h3>
            <table class="ts-table">
                <thead>
                    <tr>
                        <th style="width:30px;"></th>
                        <th>Task</th>
                        <th>Category</th>
                        <th>Qty</th>
                        <th>Tech Notes</th>
                    </tr>
                </thead>
                <tbody>${taskRows}</tbody>
            </table>
            ${notesHtml}
        </section>`;
}

function buildPhotoRefSectionHtml(selectedPhotos) {
    if (!selectedPhotos || selectedPhotos.length === 0) {
        return `
            <section class="ts-section">
                <h3 class="ts-section-title">Selected Photos</h3>
                <p style="color:#888; font-size:13px;">No photos selected for this Tech Sheet.</p>
            </section>`;
    }

    const photoRows = selectedPhotos.map(p => `
        <tr>
            <td>${p.slot === 'before' ? 'Before' : 'After'}</td>
            <td>${p.taskId || '—'}</td>
            <td style="font-family:monospace; font-size:11px;">${p.fileName}</td>
            <td>${p.notes || '—'}</td>
            <td>${p.capturedAt ? formatTimestamp(new Date(p.capturedAt).toISOString()) : '—'}</td>
        </tr>`).join('');

    return `
        <section class="ts-section">
            <h3 class="ts-section-title">Selected Photos (${selectedPhotos.length})</h3>
            <table class="ts-table">
                <thead>
                    <tr><th>Slot</th><th>Task ID</th><th>File</th><th>Notes</th><th>Captured</th></tr>
                </thead>
                <tbody>${photoRows}</tbody>
            </table>
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

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tech Sheet — Service Order #${serviceOrderId}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; background: #fff; padding: 30px; }
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
  .ts-task-row--finished td { color: #27ae60; }
  .ts-task-icon { text-align: center; font-size: 14px; width: 28px; }
  .ts-badge { display: inline-block; font-size: 11px; font-weight: bold; padding: 2px 8px; border-radius: 10px; margin-left: 10px; vertical-align: middle; }
  .ts-badge--complete { background: #d4edda; color: #155724; }
  .ts-badge--incomplete { background: #fff3cd; color: #856404; }
  .ts-notes-text { font-size: 12px; color: #444; line-height: 1.6; background: #f9f9f9; padding: 8px 10px; border-left: 3px solid #c0392b; margin-top: 8px; }
  .ts-company-footer { margin-top: 30px; border-top: 1px solid #e0e0e0; padding-top: 10px; font-size: 11px; color: #888; text-align: center; }
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
${buildCustomerServiceSectionHtml(wrapUpForm)}
${buildPrepSectionHtml(wrapUpForm)}
${buildServiceChecklistSectionHtml(wrapUpForm)}
${buildCleanupSectionHtml(wrapUpForm)}
${buildTasksSectionHtml(tasks, wrapUpForm.servicesCompletedNotes, wrapUpForm.allServicesCompleted)}
${buildPhotoRefSectionHtml(selectedPhotos)}

<div class="ts-company-footer">
  ${companyConfig.name} &bull; ${companyConfig.address} &bull; ${companyConfig.phone} &bull; ${companyConfig.email}
</div>

</body>
</html>`;

    return html;
}

module.exports = { generateTechSheetHtml };
