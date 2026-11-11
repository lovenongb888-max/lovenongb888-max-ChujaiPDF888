import { forwardRef } from "react";
import WebView from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview";

type Props = {
  html: string;
  onMessage: (event: WebViewMessageEvent) => void;
};

const RendererFrame = forwardRef<WebView, Props>(function RendererFrame({ html, onMessage }, ref) {
  return (
    <WebView
      ref={ref}
      source={{ html }}
      onMessage={onMessage}
      originWhitelist={["*"]}
      javaScriptEnabled
      domStorageEnabled
      allowFileAccess={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      style={{ position: "absolute", left: -1000, top: 0, width: 1, height: 1, opacity: 0.01 }}
    />
  );
});

export default RendererFrame;
