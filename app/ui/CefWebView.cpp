#include "CefWebView.h"

#if RESOSTAGE_ENABLE_CEF

#include "cef/CefLifecycle.h"

#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_render_handler.h"

namespace resostage {

class CefWebView::Handler final : public CefClient,
                                  public CefRenderHandler,
                                  public CefLifeSpanHandler,
                                  public CefLoadHandler,
                                  public CefContextMenuHandler {
public:
    explicit Handler(CefWebView* owner) : owner_(owner) {}

    void detachOwner() { owner_ = nullptr; }

    // CefClient
    CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
    CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
    CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }

    // CefRenderHandler
    bool GetScreenInfo(CefRefPtr<CefBrowser>, CefScreenInfo& screen_info) override {
        if (owner_ != nullptr) {
            float scale = static_cast<float>(juce::Component::getApproximateScaleFactorForComponent(owner_));
            if (scale < 1.0f) scale = 1.0f;
            screen_info.device_scale_factor = scale;
            return true;
        }
        return false;
    }

    bool GetScreenPoint(CefRefPtr<CefBrowser>, int viewX, int viewY, int& screenX, int& screenY) override {
        if (owner_ != nullptr) {
            const auto globalPt = owner_->localPointToGlobal(juce::Point<int>(viewX, viewY));
            screenX = globalPt.x;
            screenY = globalPt.y;
            return true;
        }
        return false;
    }

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

    bool DoClose(CefRefPtr<CefBrowser>) override {
        return false;
    }

    void OnBeforeClose(CefRefPtr<CefBrowser>) override {
        if (owner_ != nullptr) {
            owner_->handleBeforeClose();
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

    // CefContextMenuHandler
    void OnBeforeContextMenu(CefRefPtr<CefBrowser>,
                             CefRefPtr<CefFrame>,
                             CefRefPtr<CefContextMenuParams>,
                             CefRefPtr<CefMenuModel> model) override {
        if (model != nullptr) {
            model->Clear();
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

#if JUCE_MAC
#include <objc/runtime.h>
#include <objc/message.h>

struct ResoNSRect {
    struct { double x; double y; } origin;
    struct { double width; double height; } size;
};
#endif

void CefWebView::createBrowser() {
    if (browser != nullptr)
        return;

    auto* peer = getPeer();
    if (peer == nullptr)
        return;

    CefWindowInfo windowInfo;
    CefBrowserSettings browserSettings;

#if JUCE_MAC
    if (id parentView = static_cast<id>(peer->getNativeHandle())) {
        const auto compBounds = getBounds();
        ResoNSRect pBounds = ((ResoNSRect (*)(id, SEL))objc_msgSend)(parentView, sel_registerName("bounds"));
        double newY = pBounds.size.height - compBounds.getY() - compBounds.getHeight();

        windowInfo.SetAsChild(static_cast<CefWindowHandle>(parentView),
                              CefRect(compBounds.getX(), static_cast<int>(newY),
                                      compBounds.getWidth(), compBounds.getHeight()));
    }
#else
    windowInfo.SetAsChild(static_cast<CefWindowHandle>(peer->getNativeHandle()),
                          CefRect(getX(), getY(), getWidth(), getHeight()));
#endif

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

void CefWebView::handleBeforeClose() {
    browser = nullptr;
}

void CefWebView::handlePaint(const void*, int, int) {
}

void CefWebView::handleLoadError() {
    if (!triedFallback && browser != nullptr) {
        triedFallback = true;
        browser->GetMainFrame()->LoadURL(embeddedFallbackUrl.toStdString());
    }
}

void CefWebView::paint(juce::Graphics& g) {
    g.fillAll(juce::Colours::black);
}

void CefWebView::parentHierarchyChanged() {
    cef_lifecycle::whenReady([this]() {
        createBrowser();
    });
}

void CefWebView::resized() {
    if (browser != nullptr) {
#if JUCE_MAC
        if (auto windowHandle = browser->GetHost()->GetWindowHandle()) {
            id childView = static_cast<id>(windowHandle);
            if (auto* peer = getPeer()) {
                if (id parentView = static_cast<id>(peer->getNativeHandle())) {
                    const auto compBounds = getBounds();
                    ResoNSRect pBounds = ((ResoNSRect (*)(id, SEL))objc_msgSend)(parentView, sel_registerName("bounds"));
                    double newY = pBounds.size.height - compBounds.getY() - compBounds.getHeight();
                    ResoNSRect newFrame;
                    newFrame.origin.x = compBounds.getX();
                    newFrame.origin.y = newY;
                    newFrame.size.width = compBounds.getWidth();
                    newFrame.size.height = compBounds.getHeight();

                    ((void (*)(id, SEL, ResoNSRect))objc_msgSend)(childView, sel_registerName("setFrame:"), newFrame);
                }
            }
        }
#endif
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

void CefWebView::mouseDown(const juce::MouseEvent&) {}
void CefWebView::mouseUp(const juce::MouseEvent&) {}
void CefWebView::mouseDrag(const juce::MouseEvent&) {}
void CefWebView::mouseMove(const juce::MouseEvent&) {}
void CefWebView::mouseEnter(const juce::MouseEvent&) {}
void CefWebView::mouseExit(const juce::MouseEvent&) {}
void CefWebView::mouseWheelMove(const juce::MouseEvent&, const juce::MouseWheelDetails&) {}

bool CefWebView::keyPressed(const juce::KeyPress&) {
    return false;
}

bool CefWebView::keyStateChanged(bool) {
    return false;
}

} // namespace resostage

#endif // RESOSTAGE_ENABLE_CEF
