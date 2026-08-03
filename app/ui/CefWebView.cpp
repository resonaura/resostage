#include "CefWebView.h"

#if RESOSTAGE_ENABLE_CEF

#include "cef/CefLifecycle.h"

#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_render_handler.h"

namespace resostage {

class CefWebView::Handler final : public CefClient,
                                  public CefRenderHandler,
                                  public CefLifeSpanHandler,
                                  public CefLoadHandler {
public:
    explicit Handler(CefWebView* owner) : owner_(owner) {}

    void detachOwner() { owner_ = nullptr; }

    // CefClient
    CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
    CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }

    // CefRenderHandler
    void GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override {
        if (owner_ != nullptr) {
            rect.Set(0, 0, juce::jmax(1, owner_->getWidth()), juce::jmax(1, owner_->getHeight()));
        } else {
            rect.Set(0, 0, 800, 600);
        }
    }

    void OnPaint(CefRefPtr<CefBrowser>,
                 PaintElementType type,
                 const RectList&,
                 const void* buffer,
                 int width,
                 int height) override {
        if (type == PET_VIEW && owner_ != nullptr) {
            owner_->handlePaint(buffer, width, height);
        }
    }

    // CefLifeSpanHandler
    void OnAfterCreated(CefRefPtr<CefBrowser> b) override {
        if (owner_ != nullptr) {
            owner_->handleAfterCreated(b);
        }
    }

    // CefLoadHandler
    void OnLoadError(CefRefPtr<CefBrowser>,
                     CefRefPtr<CefFrame> f,
                     ErrorCode errorCode,
                     const CefString&,
                     const CefString&) override {
        if (f->IsMain() && owner_ != nullptr && errorCode != ERR_ABORTED) {
            owner_->handleLoadError();
        }
    }

    void OnLoadingStateChange(CefRefPtr<CefBrowser>,
                              bool isLoading,
                              bool,
                              bool) override {
        if (!isLoading && owner_ != nullptr && owner_->onPageLoaded) {
            owner_->onPageLoaded();
        }
    }

private:
    CefWebView* owner_;

    IMPLEMENT_REFCOUNTING(Handler);
};

CefWebView::CefWebView(juce::String fallbackUrl)
    : devServerUrl("http://localhost:2900/?embedded=1"),
      embeddedFallbackUrl(std::move(fallbackUrl) + "?embedded=1") {
    handler = new Handler(this);
    setOpaque(true);
    setWantsKeyboardFocus(true);

    cef_lifecycle::whenReady([this]() {
        createBrowser();
    });
}

CefWebView::~CefWebView() {
    if (handler != nullptr) {
        handler->detachOwner();
    }
    if (browser != nullptr) {
        browser->GetHost()->CloseBrowser(true);
        browser = nullptr;
    }
}

void CefWebView::createBrowser() {
    if (browser != nullptr)
        return;

    CefWindowInfo windowInfo;
    CefBrowserSettings browserSettings;

    windowInfo.SetAsWindowless(nullptr);
    windowInfo.shared_texture_enabled = false;

    CefBrowserHost::CreateBrowser(
        windowInfo,
        handler,
        devServerUrl.toStdString(),
        browserSettings,
        nullptr,
        nullptr
    );
}

void CefWebView::handleAfterCreated(CefRefPtr<CefBrowser> b) {
    browser = b;
    resized();
}

void CefWebView::handlePaint(const void* buffer, int width, int height) {
    if (width <= 0 || height <= 0 || buffer == nullptr)
        return;

    if (frame.getWidth() != width || frame.getHeight() != height) {
        frame = juce::Image(juce::Image::ARGB, width, height, true);
    }

    juce::Image::BitmapData destData(frame, juce::Image::BitmapData::writeOnly);
    const uint8_t* src = static_cast<const uint8_t*>(buffer);

    for (int y = 0; y < height; ++y) {
        uint8_t* destLine = destData.getLinePointer(y);
        const uint8_t* srcLine = src + (y * width * 4);

        for (int x = 0; x < width; ++x) {
            const uint8_t b = srcLine[x * 4 + 0];
            const uint8_t g = srcLine[x * 4 + 1];
            const uint8_t r = srcLine[x * 4 + 2];
            const uint8_t a = srcLine[x * 4 + 3];

            destLine[x * 4 + 0] = b;
            destLine[x * 4 + 1] = g;
            destLine[x * 4 + 2] = r;
            destLine[x * 4 + 3] = a;
        }
    }

    repaint();
}

void CefWebView::handleLoadError() {
    if (!triedFallback && browser != nullptr) {
        triedFallback = true;
        browser->GetMainFrame()->LoadURL(embeddedFallbackUrl.toStdString());
    }
}

void CefWebView::paint(juce::Graphics& g) {
    if (frame.isValid()) {
        g.drawImageAt(frame, 0, 0);
    } else {
        g.fillAll(juce::Colours::black);
    }
}

void CefWebView::resized() {
    if (browser != nullptr) {
        browser->GetHost()->WasResized();
    }
}

void CefWebView::visibilityChanged() {
    if (browser != nullptr) {
        browser->GetHost()->WasHidden(!isVisible());
    }
}

void CefWebView::focusGained(FocusChangeType) {
    if (browser != nullptr) {
        browser->GetHost()->SetFocus(true);
    }
}

void CefWebView::focusLost(FocusChangeType) {
    if (browser != nullptr) {
        browser->GetHost()->SetFocus(false);
    }
}

static uint32_t getCefModifiers(const juce::MouseEvent& e) {
    uint32_t modifiers = 0;
    if (e.mods.isShiftDown()) modifiers |= EVENTFLAG_SHIFT_DOWN;
    if (e.mods.isCtrlDown()) modifiers |= EVENTFLAG_CONTROL_DOWN;
    if (e.mods.isAltDown()) modifiers |= EVENTFLAG_ALT_DOWN;
    if (e.mods.isCommandDown()) modifiers |= EVENTFLAG_COMMAND_DOWN;
    if (e.mods.isLeftButtonDown()) modifiers |= EVENTFLAG_LEFT_MOUSE_BUTTON;
    if (e.mods.isMiddleButtonDown()) modifiers |= EVENTFLAG_MIDDLE_MOUSE_BUTTON;
    if (e.mods.isRightButtonDown()) modifiers |= EVENTFLAG_RIGHT_MOUSE_BUTTON;
    return modifiers;
}

void CefWebView::mouseDown(const juce::MouseEvent& e) {
    if (browser == nullptr) return;
    grabKeyboardFocus();
    CefMouseEvent mouseEvent;
    mouseEvent.x = e.x;
    mouseEvent.y = e.y;
    mouseEvent.modifiers = getCefModifiers(e);

    CefBrowserHost::MouseButtonType btn = MBT_LEFT;
    if (e.mods.isRightButtonDown()) btn = MBT_RIGHT;
    else if (e.mods.isMiddleButtonDown()) btn = MBT_MIDDLE;

    browser->GetHost()->SendMouseClickEvent(mouseEvent, btn, false, e.getNumberOfClicks());
}

void CefWebView::mouseUp(const juce::MouseEvent& e) {
    if (browser == nullptr) return;
    CefMouseEvent mouseEvent;
    mouseEvent.x = e.x;
    mouseEvent.y = e.y;
    mouseEvent.modifiers = getCefModifiers(e);

    CefBrowserHost::MouseButtonType btn = MBT_LEFT;
    if (e.mods.isRightButtonDown()) btn = MBT_RIGHT;
    else if (e.mods.isMiddleButtonDown()) btn = MBT_MIDDLE;

    browser->GetHost()->SendMouseClickEvent(mouseEvent, btn, true, e.getNumberOfClicks());
}

void CefWebView::mouseDrag(const juce::MouseEvent& e) {
    mouseMove(e);
}

void CefWebView::mouseMove(const juce::MouseEvent& e) {
    if (browser == nullptr) return;
    CefMouseEvent mouseEvent;
    mouseEvent.x = e.x;
    mouseEvent.y = e.y;
    mouseEvent.modifiers = getCefModifiers(e);
    browser->GetHost()->SendMouseMoveEvent(mouseEvent, false);
}

void CefWebView::mouseEnter(const juce::MouseEvent& e) {
    mouseMove(e);
}

void CefWebView::mouseExit(const juce::MouseEvent& e) {
    if (browser == nullptr) return;
    CefMouseEvent mouseEvent;
    mouseEvent.x = e.x;
    mouseEvent.y = e.y;
    mouseEvent.modifiers = getCefModifiers(e);
    browser->GetHost()->SendMouseMoveEvent(mouseEvent, true);
}

void CefWebView::mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& wheel) {
    if (browser == nullptr) return;
    CefMouseEvent mouseEvent;
    mouseEvent.x = e.x;
    mouseEvent.y = e.y;
    mouseEvent.modifiers = getCefModifiers(e);
    browser->GetHost()->SendMouseWheelEvent(mouseEvent, static_cast<int>(wheel.deltaX * 100.0f), static_cast<int>(wheel.deltaY * 100.0f));
}

bool CefWebView::keyPressed(const juce::KeyPress& key) {
    if (browser == nullptr) return false;
    CefKeyEvent event;
    event.type = KEYEVENT_CHAR;
    event.character = static_cast<char16_t>(key.getTextCharacter());
    event.unmodified_character = static_cast<char16_t>(key.getTextCharacter());
    browser->GetHost()->SendKeyEvent(event);
    return true;
}

bool CefWebView::keyStateChanged(bool) {
    return false;
}

} // namespace resostage

#endif // RESOSTAGE_ENABLE_CEF
