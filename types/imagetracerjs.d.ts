declare module "imagetracerjs" {
  const ImageTracer: {
    imageToSVG: (url: string, callback: (svg: string) => void, preset?: string | Record<string, unknown>) => void;
    imagedataToSVG: (imageData: ImageData, preset?: string | Record<string, unknown>) => string;
  };
  export default ImageTracer;
}
