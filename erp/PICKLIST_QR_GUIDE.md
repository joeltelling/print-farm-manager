# Pick List with QR Code Feature Guide

## Overview
The enhanced pick list system provides:
1. **Improved Pick List**: Shows component quantities per unit and total quantities needed
2. **QR Code**: Integrated QR code for easy scanning
3. **QR Scanner UI**: Mobile-friendly interface to complete WO directly from pick list

## Features

### 1. Enhanced Pick List (in wo.html)

When you generate a pick list from a WO, it now shows:
- **Component** - Component name/SKU
- **Qty per Unit** - How many units of this component per finished good
- **Qty Planned** - Total quantity needed (qty_per_unit × qty_planned)

Example:
```
Pick List WO 5
Item: PowerMig
Qty Planned: 1

Component          Qty per Unit  Qty Planned
Raw Material A     2.5           2.5
Component B        1             1
```

### 2. QR Code at Bottom of Pick List

The printed pick list includes a QR code at the bottom that links to:
```
http://192.168.50.155:8000/ui/qr-scan.html?wo=5
```

When scanned (on mobile/tablet):
- Automatically opens the QR Scanner page
- Shows WO details and completion options
- No manual typing needed

### 3. QR Scanner Interface (qr-scan.html)

**Two Completion Methods:**

#### Option A: "All Finished"
- Completes entire WO with qty_planned
- Single button click
- Status changes to "closed"

#### Option B: Specific Quantity
- Enter exact quantity completed
- Click "Complete" button
- Status changes to "closed" with that quantity

**Example UI:**
```
WO #5
PowerMig
Qty Planned: 1

[ ✓ All Finished ]

Quantity: [____] [ Complete ]

[ Cancel ]
```

## Flow Diagram

```
Pick List (wo.html)
    ↓
Print Pick List with QR Code
    ↓
Scan QR → Opens qr-scan.html?wo=5
    ↓
Select Completion Method:
  • All Finished → Complete with qty_planned
  • Specific Qty → Complete with custom qty
    ↓
POST /wo/{wo_id}/complete
    ↓
Success → Status: "closed", wo_labor updated, stock moved
```

## Technical Details

### Pick List Generation (wo.html - downloadPickList function)
- Uses `https://api.qrserver.com` for QR code generation
- QR encodes: `{origin}/ui/qr-scan.html?wo={woId}`
- Automatically calculates: qty_per_unit × qty_planned

### QR Scanner (qr-scan.html)
- Gets WO ID from URL parameter: `?wo=5`
- Loads WO details via `GET /wo/{id}`
- On completion: `POST /wo/{id}/complete` with `qty_completed` payload
- Handles errors gracefully with retry option

### Endpoint
**POST /wo/{wo_id}/complete**

Body (optional):
```json
{
  "qty_completed": 3
}
```

Without qty_completed → uses qty_planned
With qty_completed → uses specified quantity

Response:
```json
{
  "id": 5,
  "status": "closed",
  "qty": 3.0,
  "qty_planned": 5.0
}
```

## Workflow Example

1. In Work Orders page (wo.html):
   - Click "Pick List" button on WO
   - PDF opens with pick list
   - Includes QR code at bottom

2. Print the pick list

3. In warehouse with mobile device:
   - Open camera app or QR scanner
   - Scan QR code on pick list
   - Browser opens qr-scan.html

4. On QR Scanner page:
   - See WO details (Item, Qty Planned)
   - Choose completion method:
     - "All Finished" → Completes entire qty_planned
     - Enter number → Completes specific quantity
   - Click button
   - Confirmation message → Done

5. System automatically:
   - Creates wo_labor entries (with LABOR hours if BOM has them)
   - Consumes components from inventory
   - Receives finished goods to warehouse
   - Updates WO status to "closed"

## Notes
- QR scanner works on any device with camera + browser
- Endpoint is CORS-enabled for cross-origin requests
- LABOR rates automatically fetched from `machine` table
- No authentication required for scanning (public endpoint)
