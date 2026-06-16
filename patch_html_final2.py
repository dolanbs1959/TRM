import re

with open("src/app/estimate/estimate.page.html", "r") as f:
    content = f.read()

search_block = """            <div class="active-item-grid">
              <label>
                <span class="detail-label">Qty Needed</span>
                <ion-input
                  type="number"
                  min="1"
                  placeholder="Qty"
                  [ngModel]="item.qtyNeeded || null"
                  (ngModelChange)="item.qtyNeeded = $event; onActiveItemChanged(item)"
                ></ion-input>
              </label>

              <label>
                <span class="detail-label">Price</span>
                <ion-input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  [ngModel]="item.price || null"
                  (ngModelChange)="item.price = $event; onActiveItemChanged(item)"
                ></ion-input>
              </label>

              <label>
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

replace_block = """            <div class="active-item-grid" style="align-items: center; justify-content: flex-start; gap: 8px;">
              <label style="flex: 1; max-width: 80px;">
                <span class="detail-label">Qty Needed</span>
                <ion-input
                  type="number"
                  min="1"
                  placeholder="Qty"
                  [ngModel]="item.qtyNeeded || null"
                  (ngModelChange)="item.qtyNeeded = $event; onActiveItemChanged(item)"
                ></ion-input>
              </label>

              <span style="color: var(--ion-color-medium); font-weight: bold; margin-top: 15px;">&times;</span>

              <label style="flex: 1; max-width: 100px;">
                <span class="detail-label">Price</span>
                <ion-input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  [ngModel]="item.price || null"
                  (ngModelChange)="item.price = $event; onActiveItemChanged(item)"
                ></ion-input>
              </label>

              <span style="color: var(--ion-color-medium); font-weight: bold; margin-top: 15px;" *ngIf="isPerSquareUnit(item.unit) || isPerLinearUnit(item.unit)">&times;</span>

              <label *ngIf="isPerSquareUnit(item.unit) || isPerLinearUnit(item.unit)" style="flex: 1; max-width: 100px;">
                <span class="detail-label">{{ isPerLinearUnit(item.unit) ? 'Linear Feet' : 'Sq Footage' }}</span>
                <ion-input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0"
                  [ngModel]="item.sqFootage || null"
                  (ngModelChange)="item.sqFootage = $event; onActiveItemChanged(item)"
                ></ion-input>
              </label>

              <span style="color: var(--ion-color-medium); font-weight: bold; margin-top: 15px;">=</span>

              <div class="active-item-subtotal" style="flex: 1; margin-top: 15px;">
                <span class="detail-label">Line Subtotal</span>
                <span class="pricing-value">{{ formatCurrency(item.lineSubtotal) }}</span>
              </div>
            </div>"""

if search_block in content:
    content = content.replace(search_block, replace_block)
    with open("src/app/estimate/estimate.page.html", "w") as f:
        f.write(content)
    print("Success")
else:
    print("Failed to find block")
