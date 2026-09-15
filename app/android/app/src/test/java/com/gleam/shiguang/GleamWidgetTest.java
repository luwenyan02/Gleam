package com.gleam.shiguang;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;
import org.junit.Test;

public class GleamWidgetTest {
    @Test public void cachedPeriodUsesInclusiveStartExclusiveEnd() {
        assertTrue(GleamWidget.isCurrentPeriod(100, 100, 200));
        assertTrue(GleamWidget.isCurrentPeriod(199, 100, 200));
        assertFalse(GleamWidget.isCurrentPeriod(200, 100, 200));
        assertFalse(GleamWidget.isCurrentPeriod(99, 100, 200));
        assertFalse(GleamWidget.isCurrentPeriod(100, 0, 0));
        assertFalse(GleamWidget.isCurrentPeriod(100, 200, 100));
    }
    @Test public void supportsNarrowMediumAndWideLauncherSizes() {
        assertFalse(GleamWidget.useWideLayout(140));
        assertFalse(GleamWidget.useWideLayout(220));
        assertTrue(GleamWidget.useWideLayout(250));
        assertTrue(GleamWidget.useWideLayout(360));
    }
}
