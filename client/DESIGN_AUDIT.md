# URIDA Portal - Design Audit & High-Fidelity Wireframe Specification

## 1. Executive Summary
This document outlines the findings of a comprehensive UI/UX audit of the URIDA Portal, specifically focusing on the login experience and responsive behavior. The primary goal is to restore the visual integrity observed in the staging environment while adhering to modern design principles and accessibility standards.

## 2. Design System & Principles

### 2.1 Grid & Spacing
- **Base Unit**: 8px (standard material/iOS grid).
- **Margins/Padding**:
  - `xs`: 4px
  - `sm`: 8px
  - `md`: 16px
  - `lg`: 24px
  - `xl`: 32px
  - `xxl`: 48px
- **Container Max-Widths**:
  - Desktop Large: 1440px
  - Desktop: 1200px
  - Tablet: 992px
  - Mobile Landscape: 768px
  - Mobile Portrait: 375px

### 2.2 Typography (System Font Stack: Segoe UI, Roboto, sans-serif)
- **H1 (Page Title)**: 28px / 36px (Bold, Color: #E67E22 - Primary Orange)
- **H2 (Section/Card Title)**: 20px / 28px (Semi-Bold, Color: #333333)
- **H3 (Official Name)**: 16px / 24px (Bold, Color: #E65100 - Dark Orange)
- **Body (Official Title)**: 14px / 20px (Regular, Color: #444444)
- **Input Text**: 16px / 24px (Regular, Color: #222222)
- **Button Text**: 16px / 24px (Bold, Color: #FFFFFF, Uppercase)

### 2.3 Color Palette
- **Primary**: #FF9933 (Saffron Orange)
- **Primary Dark**: #E65100
- **Background**: #F8F9FA (Light Gray)
- **Card Background**: #FFF8E1 (Light Beige for Officials) / #FFFFFF (Standard)
- **Text Primary**: #212121
- **Text Secondary**: #616161
- **Border**: #DDDDDD

### 2.4 Shadows & Elevation
- **Card Default**: `0 2px 8px rgba(0,0,0,0.08)`
- **Card Hover**: `0 8px 16px rgba(0,0,0,0.12)`
- **Modal**: `0 12px 24px rgba(0,0,0,0.2)`
- **CM Cutout**: `drop-shadow(0 4px 12px rgba(0,0,0,0.15))`

---

## 3. Login Page Audit & Proposed Changes

### 3.1 Header (Visual Regression: "Jibberish Image")
- **Current Issue**: Single image banner stretches on wide screens, causing pixelation ("jibberish").
- **Proposed Fix**: Deconstruct the header into 3 flexible components:
  1. **Left**: URIDA Logo (SVG/PNG) - Fixed aspect ratio.
  2. **Center**: Text Title "URBAN ROAD INFRASTRUCTURE DEVELOPMENT AGENCY" (Responsive Typography).
  3. **Right**: UP Govt Emblem (SVG/PNG) - Fixed aspect ratio.
- **Responsive Behavior**:
  - Desktop: Row layout (Logo - Text - Logo).
  - Mobile: Column layout (Logos side-by-side, Text below).

### 3.2 Main Content Layout (Visual Regression: "Alignment & Spaces")
- **Current Issue**:
  - Gaps are inconsistent.
  - CM Image alignment feels "floating".
  - Login form overlaps road image awkwardly.
- **Proposed Fix (The Wireframe)**:
  - **3-Column Grid**:
    1. **Left (30%)**: Hon'ble CM.
       - Image: `CM-Yogi-PNG.png` (High Res).
       - Background: CSS-generated Circle (`#FFC107`), perfectly centered behind the cutout.
       - Caption: Centered below image.
    2. **Center (40%)**: Login Interaction.
       - Background: `maxresdefault.jpg` (Road Image) with `border-radius: 16px`.
       - Overlay: Login Form Card (White, Semi-transparent `rgba(255,255,255,0.95)`).
       - Inputs: Styled with 1px border, focus state orange.
       - Button: Full width "Nagar Nigam Login" (Orange Gradient).
    3. **Right (30%)**: Officials Stack.
       - 4 Cards (Minister 1, Minister 2, Principal Secretary, CEO).
       - Card Layout: Row (Avatar Left, Text Right) on Mobile/Tablet; Column (Avatar Top, Text Bottom) on Desktop to save vertical space?
       - *Correction based on Staging*: Staging shows Row layout (Avatar Left) inside the card. We will use **Row Layout** for better information density.

### 3.3 Footer (Visual Regression: "Too Big")
- **Current Issue**: Footer banner dominates the screen height.
- **Proposed Fix**:
  - Limit `max-height` to 60px.
  - Use `object-fit: contain`.
  - Add "Developed by RSAC" as selectable text, not just image, for better clarity if possible (or keep image if strict requirement).

---

## 4. Component Inventory (Reusable)

### 4.1 `OfficialCard`
- **Props**: `image`, `name`, `title`, `rank` (primary/secondary).
- **Styles**:
  - `padding: 12px`
  - `border-radius: 12px`
  - `background: #FFF8E1`
  - `display: flex`
  - `gap: 12px`
  - `align-items: center`

### 4.2 `ResponsiveImage`
- **Props**: `src`, `alt`, `className`, `sizes`.
- **Logic**: Uses `srcset` for optimization.

### 4.3 `LoginForm`
- **States**: Default, Loading, Error.
- **Elements**: Username Input, Password Input, Submit Button.

---

## 5. Responsive Breakpoints Strategy

| Breakpoint | Layout | CM Image | Login Form | Officials |
|------------|--------|----------|------------|-----------|
| **1200px+** | 3-Col (Left-Center-Right) | Large (300px) | Centered on Road | Stacked Vertical |
| **992px-1199px** | 3-Col (Compressed) | Medium (240px) | Centered | Stacked |
| **768px-991px** | 2-Col (CM Left, Login Right) | Medium (200px) | Below CM | Below Login (Grid 2x2) |
| **<768px** | 1-Col Stack | Small (180px) | Full Width | Stacked Vertical |

