// Native text accessibility for the custom-painted document surface.
#pragma once

// Call before any accessibility property is set on the first DocumentView.
// Installing a factory is process-local; it does not activate a screen reader.
void installDocumentAccessibility();
