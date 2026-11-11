import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import RendererFrame from "@/lib/pdf888/RendererFrame";

import { translations, type Locale } from "@/lib/pdf888/i18n";
import { makeRendererHtml } from "@/lib/pdf888/renderer";
import { saveImagesToLibrary } from "@/lib/pdf888/saveImages";

type Format = "png" | "jpg" | "image";
type PageFile = { page: number; uri: string; mime: string; saved?: boolean };
type ConversionState = "idle" | "loading" | "converting" | "done" | "error";
const TEAL = "#0B766E";
const OUTPUT_DIR = `${FileSystem.cacheDirectory ?? ""}pdf888-output/`;
const VERSION = Constants.expoConfig?.version ?? "1.0.0";
const MANIFEST_URL = String(Constants.expoConfig?.extra?.updateManifestUrl ?? "");
const RESOLUTIONS = [
  { key: "standard", scale: 1.25, hint: "150 dpi" },
  { key: "high", scale: 1.75, hint: "210 dpi" },
  { key: "ultra", scale: 2.25, hint: "270 dpi" },
] as const;

export default function HomeScreen() {
  const [locale, setLocale] = useState<Locale>("th");
  const t = translations[locale];
  const [format, setFormat] = useState<Format>("png");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]["key"]>("high");
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [pages, setPages] = useState<PageFile[]>([]);
  const [status, setStatus] = useState<ConversionState>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [activePage, setActivePage] = useState(0);
  const [showExit, setShowExit] = useState(false);
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordIncorrect, setPasswordIncorrect] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<string | null>(null);
  const webview = useRef<any>(null);
  const webviewReady = useRef(false);
  const passwordCancelled = useRef(false);
  const pageWrites = useRef<Promise<void>>(Promise.resolve());
  const workingHtml = useMemo(() => makeRendererHtml(), []);

  const cleanupTempFiles = useCallback(async () => {
    try {
      if (FileSystem.getInfoAsync && OUTPUT_DIR) {
        const info = await FileSystem.getInfoAsync(OUTPUT_DIR);
        if (info.exists) await FileSystem.deleteAsync(OUTPUT_DIR, { idempotent: true });
      }
      if (file?.uri?.startsWith(FileSystem.cacheDirectory ?? "__no_cache__")) {
        await FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => undefined);
      }
    } catch {
      // Cleanup is best-effort; no source files are uploaded or persisted by this app.
    }
  }, [file]);

  const resetWork = useCallback(async () => {
    await cleanupTempFiles();
    setFile(null);
    setPages([]);
    setProgress({ current: 0, total: 0 });
    setActivePage(0);
    setStatus("idle");
  }, [cleanupTempFiles]);

  const confirmExit = useCallback(async () => {
    setShowExit(false);
    await cleanupTempFiles();
    webview.current?.clearCache(true);
    webviewReady.current = false;
    setPages([]);
    setFile(null);
    if (Platform.OS === "android") BackHandler.exitApp();
  }, [cleanupTempFiles]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setShowExit(true);
      return true;
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    void cleanupTempFiles();
  }, [cleanupTempFiles]);

  const choosePdf = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const picked = result.assets[0];
    if (picked.mimeType && picked.mimeType !== "application/pdf" && !picked.name.toLowerCase().endsWith(".pdf")) {
      Alert.alert(t.errorTitle, t.pickPdfOnly);
      return;
    }
    await cleanupTempFiles();
    setPages([]);
    setProgress({ current: 0, total: 0 });
    setActivePage(0);
    setFile(picked);
    setStatus("idle");
  };

  const startConversion = async () => {
    if (!file) {
      await choosePdf();
      return;
    }
    if (!webviewReady.current) {
      setStatus("loading");
      return;
    }
    try {
      setPages([]);
      setPassword("");
      setPasswordIncorrect(false);
      setShowPasswordPrompt(false);
      setProgress({ current: 0, total: 0 });
      setStatus("converting");
      pageWrites.current = Promise.resolve();
      if (OUTPUT_DIR) await FileSystem.makeDirectoryAsync(OUTPUT_DIR, { intermediates: true });
      const base64 = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const selectedScale = RESOLUTIONS.find((item) => item.key === resolution)?.scale ?? 1.75;
      const effectiveFormat = format === "jpg" ? "jpg" : "png";
      const payload = JSON.stringify({ base64, scale: selectedScale, format: effectiveFormat });
      webview.current?.injectJavaScript(`window.convertPdf(${payload}); true;`);
    } catch (error) {
      setStatus("error");
      Alert.alert(t.errorTitle, error instanceof Error ? error.message : String(error));
    }
  };

  const handleRendererMessage = (event: { nativeEvent: { data: string } }) => {
    let message: { type?: string; page?: number; total?: number; mime?: string; data?: string; message?: string; incorrect?: boolean };
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === "ready") {
      webviewReady.current = true;
      if (status === "loading") void startConversion();
    } else if (message.type === "started") {
      setProgress({ current: 0, total: message.total ?? 0 });
    } else if (message.type === "passwordRequired") {
      setPasswordIncorrect(Boolean(message.incorrect));
      setPassword("");
      setShowPasswordPrompt(true);
    } else if (message.type === "page" && message.data && message.page) {
      const currentPage = message.page;
      const currentFormat = message.mime === "image/jpeg" ? "jpg" : "png";
      setProgress({ current: currentPage, total: message.total ?? 0 });
      pageWrites.current = pageWrites.current.then(async () => {
        const path = `${OUTPUT_DIR}page-${String(currentPage).padStart(5, "0")}.${currentFormat}`;
        await FileSystem.writeAsStringAsync(path, message.data!, { encoding: FileSystem.EncodingType.Base64 });
        setPages((previous) => [...previous, { page: currentPage, uri: path, mime: message.mime ?? "image/png" }]);
        if (currentPage === 1) setActivePage(0);
      }).catch((error) => {
        setStatus("error");
        Alert.alert(t.errorTitle, error instanceof Error ? error.message : String(error));
      });
    } else if (message.type === "complete") {
      void pageWrites.current.then(() => setStatus("done"));
    } else if (message.type === "error" || message.type === "engineError") {
      if (passwordCancelled.current) {
        passwordCancelled.current = false;
        setStatus("idle");
        return;
      }
      setStatus("error");
      Alert.alert(t.errorTitle, message.message ?? "PDF rendering failed");
    }
  };

  const submitPassword = () => {
    if (!password.trim()) return;
    const value = JSON.stringify(password);
    setShowPasswordPrompt(false);
    setPasswordIncorrect(false);
    webview.current?.injectJavaScript(`window.__pdf888UpdatePassword && window.__pdf888UpdatePassword(${value}); true;`);
    setPassword("");
  };

  const cancelPasswordPrompt = () => {
    passwordCancelled.current = true;
    setShowPasswordPrompt(false);
    setPassword("");
    webview.current?.injectJavaScript("window.cancelPdf && window.cancelPdf(); true;");
  };

  const saveToDevice = async () => {
    if (!pages.length) return;
    try {
      if (Platform.OS === "android") {
        const selection = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!selection.granted) return;
        const baseName = (file?.name ?? "PDF888").replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
        for (const page of pages) {
          const extension = page.mime === "image/jpeg" ? "jpg" : "png";
          const outputUri = await FileSystem.StorageAccessFramework.createFileAsync(
            selection.directoryUri,
            `${baseName}-page-${String(page.page).padStart(5, "0")}.${extension}`,
            page.mime,
          );
          const data = await FileSystem.readAsStringAsync(page.uri, { encoding: FileSystem.EncodingType.Base64 });
          await FileSystem.writeAsStringAsync(outputUri, data, { encoding: FileSystem.EncodingType.Base64 });
        }
      } else {
        const result = await saveImagesToLibrary(pages.map((page) => page.uri));
        if (!result.granted) {
          Alert.alert(t.errorTitle, t.permission);
          return;
        }
      }
      setPages((previous) => previous.map((page) => ({ ...page, saved: true })));
      Alert.alert(t.done, t.savedAll);
    } catch (error) {
      Alert.alert(t.errorTitle, error instanceof Error ? error.message : String(error));
    }
  };

  const shareToCloud = async () => {
    if (!pages.length) return;
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert(t.errorTitle, t.shareUnavailable);
      return;
    }
    const page = pages[activePage] ?? pages[0];
    await Sharing.shareAsync(page.uri, {
      mimeType: page.mime,
      dialogTitle: `${file?.name ?? "PDF888"} · ${t.page} ${page.page}`,
    });
  };

  const checkForUpdates = async () => {
    if (!MANIFEST_URL) {
      setUpdateInfo(t.updateNone);
      Alert.alert(t.updates, t.updateNone);
      return;
    }
    try {
      const response = await fetch(MANIFEST_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = (await response.json()) as { version?: string; apkUrl?: string; releaseNotes?: string };
      const current = VERSION.split(".").map(Number);
      const latest = String(manifest.version ?? "0.0.0").split(".").map(Number);
      const newer = latest.some((part, index) => (part ?? 0) > (current[index] ?? 0) && latest.slice(0, index).every((n, i) => n === current[i]));
      if (newer && manifest.apkUrl) {
        Alert.alert(`${t.updateFound}: ${manifest.version}`, `${manifest.releaseNotes ?? ""}\n\n${t.updateSignature}`, [
          { text: t.cancel, style: "cancel" },
          { text: t.updateAction, onPress: () => void Linking.openURL(manifest.apkUrl!) },
        ]);
        setUpdateInfo(`${t.updateFound}: ${manifest.version}`);
      } else {
        setUpdateInfo(t.updateCurrent);
        Alert.alert(t.updates, t.updateCurrent);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setUpdateInfo(detail);
      Alert.alert(t.errorTitle, detail);
    }
  };

  const active = pages[activePage];
  const formatOptions: { key: Format; label: string }[] = [
    { key: "png", label: t.png },
    { key: "jpg", label: t.jpg },
    { key: "image", label: t.image },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <View style={styles.brandMark}><Ionicons name="document-text" size={20} color="#FFFFFF" /></View>
          <View style={styles.brandCopy}><Text style={styles.brandName}>PDF888</Text><Text style={styles.brandTag}>{t.eyebrow}</Text></View>
          <Pressable style={styles.languageButton} onPress={() => setLocale((value) => value === "th" ? "en" : "th")} accessibilityLabel="Switch language">
            <Ionicons name="language" size={17} color={TEAL} /><Text style={styles.languageText}>{locale === "th" ? "EN" : "ไทย"}</Text>
          </Pressable>
        </View>

        <View style={styles.hero}>
          <View style={styles.heroGlow} />
          <View style={styles.eyebrow}><View style={styles.liveDot} /><Text style={styles.eyebrowText}>{t.eyebrow.toUpperCase()}</Text></View>
          <Text style={styles.title}>{t.title}</Text>
          <Text style={styles.subtitle}>{t.subtitle}</Text>
          <View style={styles.privacyPill}><Ionicons name="shield-checkmark" size={15} color={TEAL} /><Text style={styles.privacyText}>{t.privacy}</Text></View>
        </View>

        <View style={styles.sectionHeader}><Text style={styles.sectionNumber}>01</Text><Text style={styles.sectionTitle}>{t.chooseFile}</Text></View>
        <Pressable style={styles.uploadCard} onPress={() => void choosePdf()}>
          <View style={styles.uploadIcon}><Ionicons name="cloud-upload-outline" size={24} color={TEAL} /></View>
          <View style={styles.uploadCopy}><Text style={styles.uploadTitle}>{file?.name ?? t.noFile}</Text><Text style={styles.uploadSubtitle}>{file ? `${(file.size ?? 0) > 0 ? ((file.size ?? 0) / 1024 / 1024).toFixed(2) + " MB · " : ""}${t.chooseAnother}` : "PDF · เลือกจากอุปกรณ์"}</Text></View>
          <Ionicons name="chevron-forward" size={19} color="#82918F" />
        </Pressable>

        <View style={styles.sectionHeader}><Text style={styles.sectionNumber}>02</Text><Text style={styles.sectionTitle}>{t.format} & {t.resolution}</Text></View>
        <View style={styles.settingsCard}>
          <Text style={styles.fieldLabel}>{t.format}</Text>
          <View style={styles.segmentRow}>{formatOptions.map((item) => <Pressable key={item.key} onPress={() => setFormat(item.key)} style={[styles.segment, format === item.key && styles.segmentActive]}><Text style={[styles.segmentText, format === item.key && styles.segmentTextActive]}>{item.label}</Text></Pressable>)}</View>
          <View style={styles.divider} />
          <Text style={styles.fieldLabel}>{t.resolution}</Text>
          <View style={styles.resolutionRow}>{RESOLUTIONS.map((item) => <Pressable key={item.key} onPress={() => setResolution(item.key)} style={[styles.resolutionOption, resolution === item.key && styles.resolutionActive]}><Text style={[styles.resolutionLabel, resolution === item.key && styles.resolutionLabelActive]}>{t[item.key]}</Text><Text style={[styles.resolutionHint, resolution === item.key && styles.resolutionHintActive]}>{item.hint}</Text></Pressable>)}</View>
        </View>

        <Pressable style={[styles.primaryButton, (!file || status === "converting") && styles.buttonDisabled]} onPress={() => void startConversion()} disabled={status === "converting"}>
          {status === "converting" || status === "loading" ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Ionicons name="sparkles-outline" size={19} color="#FFFFFF" />}
          <Text style={styles.primaryButtonText}>{status === "converting" ? `${t.converting} ${progress.current}/${progress.total || "…"}` : status === "loading" ? t.loadingPdf : status === "done" ? t.done : t.convert}</Text>
          {status !== "converting" && status !== "loading" && <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />}
        </Pressable>
        <Text style={styles.smallNote}>{t.practicalLimit}</Text>

        {pages.length > 0 && <View style={styles.previewSection}>
          <View style={styles.previewHeading}><View style={styles.sectionHeaderCompact}><Text style={styles.sectionNumber}>03</Text><Text style={styles.sectionTitle}>{t.preview}</Text></View><Text style={styles.pageCounter}>{pages.length} {t.pageCount}</Text></View>
          <View style={styles.previewCard}>
            {active ? <Image source={{ uri: active.uri }} style={styles.previewImage} resizeMode="contain" /> : null}
            <View style={styles.previewMeta}><Text style={styles.previewPage}>{t.page} {active?.page ?? 1} / {pages.length}</Text><Text style={styles.previewFormat}>{format === "jpg" ? "JPG" : "PNG"}</Text></View>
          </View>
          {pages.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbnailRow}>{pages.map((page, index) => <Pressable key={page.uri} onPress={() => setActivePage(index)} style={[styles.thumbnail, index === activePage && styles.thumbnailActive]}><Image source={{ uri: page.uri }} style={styles.thumbnailImage} resizeMode="contain" /><Text style={styles.thumbnailLabel}>{page.page}</Text></Pressable>)}</ScrollView>}
          <View style={styles.actionRow}>
            <Pressable style={styles.saveButton} onPress={() => void saveToDevice()}><Ionicons name="download-outline" size={18} color="#FFFFFF" /><Text style={styles.saveButtonText}>{t.saveDevice}</Text></Pressable>
            <Pressable style={styles.shareButton} onPress={() => void shareToCloud()}><Ionicons name="cloud-upload-outline" size={18} color={TEAL} /><Text style={styles.shareButtonText}>{t.saveCloud}</Text></Pressable>
          </View>
          <Text style={styles.shareNote}>{t.saveCloud}: {locale === "th" ? "เลือกแอป Drive/Cloud จากเมนูแชร์ของระบบ" : "Choose a Drive/cloud app from the system share menu"}</Text>
        </View>}

        {status === "error" && <View style={styles.errorCard}><Ionicons name="warning-outline" size={18} color="#B74232" /><Text style={styles.errorText}>{locale === "th" ? "ไม่สามารถแปลงไฟล์ได้ ลองลดความละเอียดหรือตรวจสอบพื้นที่ว่าง" : "Could not convert. Try a lower resolution or check free storage."}</Text></View>}

        <View style={styles.utilityCard}>
          <View style={styles.versionLine}><View><Text style={styles.utilityLabel}>{t.version}</Text><Text style={styles.versionValue}>{VERSION}</Text></View><Pressable style={styles.updateButton} onPress={() => void checkForUpdates()}><Ionicons name="refresh-outline" size={16} color={TEAL} /><Text style={styles.updateButtonText}>{t.updates}</Text></Pressable></View>
          {updateInfo ? <Text style={styles.updateStatus}>{updateInfo}</Text> : null}
          <View style={styles.divider} />
          <Pressable style={styles.clearButton} onPress={() => void resetWork()}><Ionicons name="trash-outline" size={16} color="#596A68" /><Text style={styles.clearButtonText}>{t.reset}</Text></Pressable>
        </View>
        <View style={styles.footer}><View style={styles.footerRule} /><Text style={styles.footerText}>{t.footer}</Text><Text style={styles.footerVersion}>PDF888 · {VERSION}</Text></View>
      </ScrollView>

      <RendererFrame ref={webview} html={workingHtml} onMessage={handleRendererMessage} />

      <Modal visible={showExit} transparent animationType="fade" onRequestClose={() => setShowExit(false)}>
        <View style={styles.modalBackdrop}><View style={styles.exitModal}><View style={styles.modalIcon}><Ionicons name="exit-outline" size={24} color={TEAL} /></View><Text style={styles.modalTitle}>{t.exitTitle}</Text><Text style={styles.modalBody}>{t.exitText}</Text><View style={styles.modalActions}><Pressable style={styles.modalCancel} onPress={() => setShowExit(false)}><Text style={styles.modalCancelText}>{t.cancel}</Text></Pressable><Pressable style={styles.modalConfirm} onPress={() => void confirmExit()}><Text style={styles.modalConfirmText}>{t.exit}</Text></Pressable></View></View></View>
      </Modal>

      <Modal visible={showPasswordPrompt} transparent animationType="fade" onRequestClose={cancelPasswordPrompt}>
        <View style={styles.modalBackdrop}>
          <View style={styles.exitModal}>
            <View style={styles.modalIcon}><Ionicons name="lock-closed-outline" size={23} color={TEAL} /></View>
            <Text style={styles.modalTitle}>{t.passwordTitle}</Text>
            <Text style={styles.modalBody}>{t.passwordText}</Text>
            {passwordIncorrect ? <Text style={styles.passwordError}>{t.passwordWrong}</Text> : null}
            <View style={[styles.passwordInputWrap, passwordIncorrect && styles.passwordInputError]}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder={t.passwordPlaceholder}
                placeholderTextColor="#93A09D"
                secureTextEntry={!passwordVisible}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="go"
                onSubmitEditing={submitPassword}
                style={styles.passwordInput}
              />
              <Pressable onPress={() => setPasswordVisible((visible) => !visible)} accessibilityLabel={passwordVisible ? t.hidePassword : t.showPassword} style={styles.passwordToggle}>
                <Ionicons name={passwordVisible ? "eye-off-outline" : "eye-outline"} size={20} color={TEAL} />
                <Text style={styles.passwordToggleText}>{passwordVisible ? t.hidePassword : t.showPassword}</Text>
              </Pressable>
            </View>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={cancelPasswordPrompt}><Text style={styles.modalCancelText}>{t.passwordCancel}</Text></Pressable>
              <Pressable style={[styles.modalConfirm, !password.trim() && styles.buttonDisabled]} onPress={submitPassword} disabled={!password.trim()}><Text style={styles.modalConfirmText}>{t.unlock}</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F5F4EF" },
  page: { paddingHorizontal: 20, paddingBottom: 30, maxWidth: 720, width: "100%", alignSelf: "center" },
  headerRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 4 },
  brandMark: { width: 38, height: 38, borderRadius: 13, backgroundColor: TEAL, alignItems: "center", justifyContent: "center" },
  brandCopy: { flex: 1 }, brandName: { color: "#182E2C", fontSize: 15, fontWeight: "800", letterSpacing: 1 }, brandTag: { color: "#7B8A87", fontSize: 10, marginTop: 2 },
  languageButton: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#E7F1EF", borderRadius: 15, paddingHorizontal: 12, paddingVertical: 8 }, languageText: { color: TEAL, fontSize: 12, fontWeight: "800" },
  hero: { backgroundColor: "#E9F1EE", borderRadius: 27, paddingHorizontal: 22, paddingTop: 22, paddingBottom: 20, marginTop: 13, overflow: "hidden", borderWidth: 1, borderColor: "#DDE9E5" }, heroGlow: { position: "absolute", width: 190, height: 190, borderRadius: 95, backgroundColor: "#D9E9E4", right: -100, top: -72 },
  eyebrow: { flexDirection: "row", alignItems: "center", gap: 7 }, liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#0B8E7E" }, eyebrowText: { color: TEAL, fontSize: 9, fontWeight: "800", letterSpacing: 1.1 },
  title: { color: "#1D3330", fontSize: 27, fontWeight: "800", lineHeight: 35, marginTop: 13 }, subtitle: { color: "#5D716E", fontSize: 13, lineHeight: 20, marginTop: 6, maxWidth: 320 }, privacyPill: { flexDirection: "row", gap: 7, alignItems: "center", alignSelf: "flex-start", marginTop: 17, backgroundColor: "#FFFFFFB8", paddingHorizontal: 11, paddingVertical: 8, borderRadius: 12 }, privacyText: { color: "#42615D", fontSize: 10, fontWeight: "600", flexShrink: 1 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 24, marginBottom: 11 }, sectionHeaderCompact: { flexDirection: "row", alignItems: "center", gap: 9 }, sectionNumber: { color: TEAL, fontSize: 10, fontWeight: "900", letterSpacing: 1 }, sectionTitle: { color: "#243936", fontSize: 14, fontWeight: "800" },
  uploadCard: { backgroundColor: "#FFFFFF", borderColor: "#E4E6E1", borderWidth: 1, borderRadius: 18, minHeight: 78, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 }, uploadIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "#EAF4F1", alignItems: "center", justifyContent: "center" }, uploadCopy: { flex: 1 }, uploadTitle: { color: "#263B38", fontSize: 13, fontWeight: "700" }, uploadSubtitle: { color: "#879390", fontSize: 11, marginTop: 5 },
  settingsCard: { backgroundColor: "#FFFFFF", borderColor: "#E4E6E1", borderWidth: 1, borderRadius: 18, padding: 15 }, fieldLabel: { color: "#5C6E6B", fontSize: 11, fontWeight: "700", marginBottom: 9 }, segmentRow: { flexDirection: "row", gap: 7 }, segment: { minHeight: 38, flex: 1, borderRadius: 11, backgroundColor: "#F4F5F2", alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }, segmentActive: { backgroundColor: "#E3F1EE", borderWidth: 1, borderColor: "#A8D1C8" }, segmentText: { color: "#677673", fontSize: 11, fontWeight: "700" }, segmentTextActive: { color: TEAL }, divider: { height: 1, backgroundColor: "#ECEEE9", marginVertical: 14 }, resolutionRow: { flexDirection: "row", gap: 8 }, resolutionOption: { flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: "center", backgroundColor: "#F4F5F2", borderWidth: 1, borderColor: "transparent" }, resolutionActive: { backgroundColor: "#E3F1EE", borderColor: "#A8D1C8" }, resolutionLabel: { color: "#596A68", fontSize: 11, fontWeight: "700" }, resolutionLabelActive: { color: TEAL }, resolutionHint: { color: "#9AA4A1", fontSize: 9, marginTop: 4 }, resolutionHintActive: { color: "#5C9990" },
  primaryButton: { marginTop: 16, minHeight: 54, borderRadius: 17, backgroundColor: TEAL, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 18, shadowColor: TEAL, shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 3 }, buttonDisabled: { opacity: 0.68 }, primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800", flex: 1 }, smallNote: { color: "#8A9794", fontSize: 10, textAlign: "center", marginTop: 9 },
  previewSection: { marginTop: 13 }, previewHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }, pageCounter: { color: "#78908A", fontSize: 11, fontWeight: "700" }, previewCard: { backgroundColor: "#FFFFFF", borderRadius: 19, borderWidth: 1, borderColor: "#E4E6E1", padding: 10 }, previewImage: { width: "100%", height: 330, backgroundColor: "#F8F8F5", borderRadius: 12 }, previewMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 5, paddingTop: 10 }, previewPage: { color: "#576C68", fontSize: 11, fontWeight: "700" }, previewFormat: { color: TEAL, fontSize: 10, fontWeight: "900" }, thumbnailRow: { gap: 8, paddingVertical: 12 }, thumbnail: { width: 65, height: 82, borderRadius: 11, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E0E5E0", padding: 5, alignItems: "center" }, thumbnailActive: { borderColor: TEAL, borderWidth: 2 }, thumbnailImage: { width: 49, height: 57, backgroundColor: "#F7F7F3", borderRadius: 5 }, thumbnailLabel: { color: "#71817D", fontSize: 9, marginTop: 3 }, actionRow: { flexDirection: "row", gap: 9 }, saveButton: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: TEAL, borderRadius: 14 }, saveButtonText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" }, shareButton: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: "#E7F1EF", borderColor: "#D1E5DF", borderWidth: 1, borderRadius: 14 }, shareButtonText: { color: TEAL, fontSize: 11, fontWeight: "800" }, shareNote: { color: "#86928F", fontSize: 10, textAlign: "center", marginTop: 9 },
  errorCard: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, marginTop: 13, borderRadius: 12, backgroundColor: "#FFF0EC" }, errorText: { color: "#9B4638", fontSize: 11, flex: 1 }, utilityCard: { backgroundColor: "#FFFFFF", borderColor: "#E4E6E1", borderWidth: 1, borderRadius: 17, padding: 15, marginTop: 23 }, versionLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, utilityLabel: { color: "#83918E", fontSize: 10, fontWeight: "700" }, versionValue: { color: "#2E4440", fontSize: 15, fontWeight: "800", marginTop: 4 }, updateButton: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#EAF4F1", borderRadius: 11, paddingHorizontal: 10, paddingVertical: 8 }, updateButtonText: { color: TEAL, fontSize: 10, fontWeight: "700" }, updateStatus: { color: "#758681", fontSize: 10, marginTop: 10 }, clearButton: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start" }, clearButtonText: { color: "#596A68", fontSize: 11, fontWeight: "700" }, footer: { alignItems: "center", paddingTop: 24, paddingBottom: 3 }, footerRule: { width: 40, height: 3, borderRadius: 2, backgroundColor: TEAL, opacity: 0.45, marginBottom: 11 }, footerText: { color: "#314945", fontSize: 12, fontWeight: "800", letterSpacing: 0.3 }, footerVersion: { color: "#96A29F", fontSize: 9, marginTop: 4 },
  passwordError: { color: "#B74232", fontSize: 12, fontWeight: "700", marginTop: 12 }, passwordInputWrap: { minHeight: 48, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#DCE5E1", borderRadius: 12, backgroundColor: "#F9FAF8", marginTop: 14, paddingHorizontal: 11 }, passwordInputError: { borderColor: "#D98173" }, passwordInput: { flex: 1, minWidth: 0, color: "#263B38", fontSize: 14, paddingVertical: 11 }, passwordToggle: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 8, paddingLeft: 7 }, passwordToggleText: { color: TEAL, fontSize: 10, fontWeight: "700" },
  renderer: { position: "absolute", left: -1000, top: 0, width: 1, height: 1, opacity: 0.01 }, modalBackdrop: { flex: 1, backgroundColor: "#10201FCC", alignItems: "center", justifyContent: "center", padding: 25 }, exitModal: { width: "100%", maxWidth: 360, backgroundColor: "#FFFFFF", borderRadius: 22, padding: 22 }, modalIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: "#E8F3F0", alignItems: "center", justifyContent: "center" }, modalTitle: { color: "#203633", fontSize: 18, fontWeight: "800", marginTop: 15 }, modalBody: { color: "#6F7F7C", fontSize: 13, lineHeight: 20, marginTop: 8 }, modalActions: { flexDirection: "row", gap: 9, marginTop: 22 }, modalCancel: { flex: 1, borderRadius: 12, backgroundColor: "#F0F2EF", minHeight: 44, alignItems: "center", justifyContent: "center" }, modalCancelText: { color: "#60716D", fontSize: 12, fontWeight: "800" }, modalConfirm: { flex: 1, borderRadius: 12, backgroundColor: TEAL, minHeight: 44, alignItems: "center", justifyContent: "center" }, modalConfirmText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
});
