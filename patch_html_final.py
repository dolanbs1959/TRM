with open("src/app/estimate/estimate.page.html", "r") as f:
    content = f.read()

search_block = """              <label>
                <span class="detail-label">Sq Footage</span>
                <ion-input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0"
                  [ngModel]="item.sqFootage || null"
                  (ngModelChange)="item.sqFootage = $event; onActiveItemChanged(item)"
                ></ion-input>
              </label>

              <div class="active-item-subtotal">
                <span class="detail-label">Line Subtotal</span>
                <span class="pricing-value">{{ formatCurrency(item.lineSubtotal) }}</span>
              </div>
            </div>"""

replace_block = """              <label *ngIf="isPerSquareUnit(item.unit)">
                <span class="detail-label">Sq Footage</span>
                <ion-input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0"
                  [ngModel]="item.sqFootage || null"
                  (ngModelChange)="item.sqFootage = $event; onActiveItemChanged(item)"
                ></ion-input>
              </label>

              <div class="active-item-subtotal">
                <span class="detail-label">Line Subtotal</span>
                <span class="pricing-value">{{ formatCurrency(item.lineSubtotal) }}</span>
              </div>
            </div>

            <div class="calculation-preview" style="padding: 4px 16px 8px 16px; font-size: 0.85rem; color: var(--ion-color-medium);">
              <span class="muted-preview" *ngIf="isPerSquareUnit(item.unit)">
                {{ item.qtyNeeded || 0 }} QTY &times; {{ formatCurrency(item.price) }} &times; {{ item.sqFootage || 0 }} SQ FT = {{ formatCurrency(item.lineSubtotal) }}
              </span>
              <span class="muted-preview" *ngIf="!isPerSquareUnit(item.unit)">
                {{ item.qtyNeeded || 0 }} QTY &times; {{ formatCurrency(item.price) }} = {{ formatCurrency(item.lineSubtotal) }}
              </span>
            </div>"""

if search_block in content:
    content = content.replace(search_block, replace_block)
    with open("src/app/estimate/estimate.page.html", "w") as f:
        f.write(content)
    print("Success")
else:
    print("Failed to find block")
