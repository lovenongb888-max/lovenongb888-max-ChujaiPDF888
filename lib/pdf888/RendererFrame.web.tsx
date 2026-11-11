import { forwardRef } from "react";
import { View } from "react-native";

type Props = {
  html: string;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
};

const RendererFrame = forwardRef<unknown, Props>(function RendererFrame() {
  // PDF rendering runs in the Android WebView build; Expo Web is a layout preview only.
  return <View accessible={false} style={{ display: "none" }} />;
});

export default RendererFrame;
