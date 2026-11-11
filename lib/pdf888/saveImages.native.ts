import * as MediaLibrary from "expo-media-library";

export async function saveImagesToLibrary(uris: string[]) {
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) return { granted: false };
  for (const uri of uris) await MediaLibrary.createAssetAsync(uri);
  return { granted: true };
}
