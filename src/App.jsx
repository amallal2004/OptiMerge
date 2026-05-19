import React, { useState, useEffect, useRef } from 'react';
import { PDFDocument, degrees } from 'pdf-lib';

function App() {
  const [images, setImages] = useState([]);
  const [isCompiling, setIsCompiling] = useState(false);
  const [compilationStep, setCompilationStep] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [compilationLog, setCompilationLog] = useState('');
  const [isDraggingOverZone, setIsDraggingOverZone] = useState(false);
  const [isDraggingOverWindow, setIsDraggingOverWindow] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState(null);
  
  // Custom View State (grid or document scroll view)
  const [viewMode, setViewMode] = useState('grid');
  
  // Zoom Inspection Preview Modal state
  const [zoomedImage, setZoomedImage] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  
  // Interactive zoom scale and panning controls
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const zoomModalBodyRef = useRef(null);

  // Reset panning and zoom whenever the active zoomed image changes
  useEffect(() => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
    setIsPanning(false);
  }, [zoomedImage]);

  // Attach a non-passive wheel event listener to enable wheel zoom and prevent page scroll
  useEffect(() => {
    const modalBody = zoomModalBodyRef.current;
    if (!modalBody) return;

    const preventWheelScroll = (e) => {
      e.preventDefault();
      const zoomFactor = 0.12;
      const delta = e.deltaY < 0 ? 1 : -1;
      setZoomScale((prev) => {
        const next = prev + delta * zoomFactor;
        return Math.min(Math.max(next, 0.4), 4.0); // 40% to 400%
      });
    };

    modalBody.addEventListener('wheel', preventWheelScroll, { passive: false });
    return () => {
      modalBody.removeEventListener('wheel', preventWheelScroll);
    };
  }, [zoomedImage]);

  const handlePanMouseDown = (e) => {
    e.preventDefault();
    setIsPanning(true);
    panStart.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
  };

  const handlePanMouseMove = (e) => {
    if (!isPanning) return;
    e.preventDefault();
    setPanOffset({
      x: e.clientX - panStart.current.x,
      y: e.clientY - panStart.current.y
    });
  };

  const handlePanMouseUpOrLeave = () => {
    setIsPanning(false);
  };
  
  // Ref drag counter for window-wide drops to avoid flickering
  const windowDragCounter = useRef(0);

  // Maintain reference to image list for state unmount garbage sweeps
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // Global window-wide drop event listeners
  useEffect(() => {
    const handleWinDragEnter = (e) => {
      e.preventDefault();
      // Ensure only external file drags (from desktop / OS) trigger the full screen overlay
      const isFileDrag = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
      if (!isFileDrag) return;

      windowDragCounter.current++;
      setIsDraggingOverWindow(true);
    };

    const handleWinDragLeave = (e) => {
      e.preventDefault();
      const isFileDrag = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
      if (!isFileDrag) return;

      windowDragCounter.current--;
      if (windowDragCounter.current <= 0) {
        windowDragCounter.current = 0;
        setIsDraggingOverWindow(false);
      }
    };

    const handleWinDragOver = (e) => {
      e.preventDefault();
      // Enable drop effect for files
      if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleWinDrop = (e) => {
      e.preventDefault();
      const isFileDrag = e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files');
      if (!isFileDrag) return;

      windowDragCounter.current = 0;
      setIsDraggingOverWindow(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleUploadFiles(e.dataTransfer.files);
      }
    };

    window.addEventListener('dragenter', handleWinDragEnter);
    window.addEventListener('dragleave', handleWinDragLeave);
    window.addEventListener('dragover', handleWinDragOver);
    window.addEventListener('drop', handleWinDrop);

    return () => {
      window.removeEventListener('dragenter', handleWinDragEnter);
      window.removeEventListener('dragleave', handleWinDragLeave);
      window.removeEventListener('dragover', handleWinDragOver);
      window.removeEventListener('drop', handleWinDrop);
    };
  }, [images]); // Rebind to capture latest state reference handler

  // Memory Garbage collection: Release Object URLs on component unmount
  useEffect(() => {
    return () => {
      imagesRef.current.forEach(img => {
        if (img.objectUrl) {
          URL.revokeObjectURL(img.objectUrl);
        }
      });
    };
  }, []);

  /**
   * Helper: Pretty-prints binary file size tags
   */
  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  /**
   * Image Metadata Reader
   */
  const loadImageDetails = (file) => {
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
          objectUrl,
          success: true
        });
      };
      img.onerror = () => {
        resolve({
          width: 0,
          height: 0,
          objectUrl,
          success: false
        });
      };
      img.src = objectUrl;
    });
  };

  /**
   * 1. Sorting Upload Logic: Distinguishes Batch and Sequential Uploads
   * 
   * - BATCH UPLOADS: Selected or dropped simultaneously (multiple files).
   *   Alphanumerically sorts the incoming batch, then appends it to the end of the queue.
   * 
   * - SEQUENTIAL UPLOADS: Appended one by one.
   *   The file is appended directly to the end of the workspace queue in its exact upload order.
   */
  const handleUploadFiles = async (fileList) => {
    const filesArray = Array.from(fileList);
    if (filesArray.length === 0) return;

    // Supported image formats: JPEG, PNG, WebP
    const supportedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const validFiles = filesArray.filter(file => supportedTypes.includes(file.type));

    if (validFiles.length === 0) {
      alert('Format incompatible: Please select JPEG, PNG, or WebP images only.');
      return;
    }

    const isBatch = validFiles.length > 1;
    const filesToProcess = [...validFiles];

    if (isBatch) {
      // Alphanumeric alphanumeric sort for batch uploads
      filesToProcess.sort((a, b) => 
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
    }

    const processedImages = [];
    for (const file of filesToProcess) {
      const details = await loadImageDetails(file);
      if (details.success) {
        processedImages.push({
          id: crypto.randomUUID ? crypto.randomUUID() : `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          file,
          name: file.name,
          size: file.size,
          type: file.type,
          objectUrl: details.objectUrl,
          width: details.width,
          height: details.height,
          rotation: 0 // Default starting rotation
        });
      }
    }

    setImages(prev => [...prev, ...processedImages]);
  };

  /**
   * Action: Rotates image clockwise or counter-clockwise
   */
  const handleRotateImage = (id, direction) => {
    setImages(prev => prev.map(img => {
      if (img.id === id) {
        const newRotation = (img.rotation + direction + 360) % 360;
        return {
          ...img,
          rotation: newRotation
        };
      }
      return img;
    }));
  };

  /**
   * Action: Shifts page order manually via keyboard/button indicators (for accessibility & mobile)
   */
  const handleMoveImage = (index, direction) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= images.length) return;

    const updatedImages = [...images];
    const [movedItem] = updatedImages.splice(index, 1);
    updatedImages.splice(targetIndex, 0, movedItem);
    setImages(updatedImages);
  };

  /**
   * Action: Duplicates Page
   */
  const handleDuplicateImage = (img) => {
    // Memory Management: Creating a new Object URL to prevent double-revoking bugs
    const duplicatedItem = {
      ...img,
      id: crypto.randomUUID ? crypto.randomUUID() : `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      objectUrl: URL.createObjectURL(img.file)
    };
    
    setImages(prev => {
      const originalIdx = prev.findIndex(item => item.id === img.id);
      const updated = [...prev];
      updated.splice(originalIdx + 1, 0, duplicatedItem);
      return updated;
    });
  };

  /**
   * Action: Deletes image
   */
  const handleDeleteImage = (id) => {
    setImages(prev => {
      const target = prev.find(img => img.id === id);
      if (target && target.objectUrl) {
        URL.revokeObjectURL(target.objectUrl);
      }
      return prev.filter(img => img.id !== id);
    });
  };

  /**
   * Action: Load premium mock demo template pages
   */
  const loadDemoImages = () => {
    const mockPages = [
      { name: 'cover_page_01.png', color: '#3b82f6', text: 'OptiMerge Cover Spread' },
      { name: 'report_page_02.png', color: '#10b981', text: 'Data Analytics Spread' },
      { name: 'appendix_page_03.png', color: '#8b5cf6', text: 'Studio Appendix Spread' }
    ];

    const demoImages = mockPages.map((page, idx) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 1600;
      const ctx = canvas.getContext('2d');
      
      // Draw background gradient
      const grad = ctx.createLinearGradient(0, 0, 1200, 1600);
      grad.addColorStop(0, page.color);
      grad.addColorStop(1, '#09090b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1200, 1600);
      
      // Draw a subtle border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 40;
      ctx.strokeRect(20, 20, 1160, 1560);
      
      // Draw typography layout
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 72px sans-serif';
      ctx.fillText(page.name.toUpperCase(), 100, 200);
      
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = '54px sans-serif';
      ctx.fillText(page.text, 100, 300);
      
      // Page numbering decoration
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = 'bold 240px sans-serif';
      ctx.fillText(`0${idx + 1}`, 800, 1450);

      // Extract raw data URI & convert to blob
      const dataUrl = canvas.toDataURL('image/png');
      
      // Convert DataURL to standard object URL
      const byteString = atob(dataUrl.split(',')[1]);
      const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mimeString });
      const objectUrl = URL.createObjectURL(blob);

      return {
        id: `demo-${idx}-${Date.now()}`,
        name: page.name,
        objectUrl,
        size: blob.size,
        type: 'image/png',
        width: 1200,
        height: 1600,
        rotation: 0
      };
    });

    setImages(demoImages);
  };

  /**
   * Action: Clear workspace
   */
  const handleClearWorkspace = () => {
    images.forEach(img => {
      if (img.objectUrl) {
        URL.revokeObjectURL(img.objectUrl);
      }
    });
    setImages([]);
    setShowClearConfirm(false);
  };

  /**
   * Action: Sort entire queue dynamically
   */
  const handleSortQueue = (sortType) => {
    if (images.length === 0) return;
    const sorted = [...images];
    
    switch (sortType) {
      case 'alpha-asc':
        sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        break;
      case 'alpha-desc':
        sorted.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }));
        break;
      case 'size-asc':
        sorted.sort((a, b) => a.size - b.size);
        break;
      case 'size-desc':
        sorted.sort((a, b) => b.size - a.size);
        break;
      case 'dim-desc':
        sorted.sort((a, b) => (b.width * b.height) - (a.width * a.height));
        break;
      case 'shuffle':
        sorted.sort(() => Math.random() - 0.5);
        break;
      default:
        return;
    }
    setImages(sorted);
  };

  /**
   * Real-time Drag-and-Drop Reordering (HTML5 Grid slide actions)
   */
  const handleDragStart = (e, index) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDragEnter = (e, index) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const updatedImages = [...images];
    const [draggedItem] = updatedImages.splice(draggedIndex, 1);
    updatedImages.splice(index, 0, draggedItem);

    setImages(updatedImages);
    setDraggedIndex(index);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDraggedIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  /**
   * Helpers for PDF compiler
   */
  const readFileAsBytes = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  };

  const convertWebPToPngBytes = (file) => {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Canvas context mapping failure.'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(async (blob) => {
          URL.revokeObjectURL(objectUrl);
          if (!blob) {
            reject(new Error('WebP translating canvas error.'));
            return;
          }
          try {
            const buffer = await blob.arrayBuffer();
            resolve(new Uint8Array(buffer));
          } catch (err) {
            reject(err);
          }
        }, 'image/png');
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      };
      img.src = objectUrl;
    });
  };

  /**
   * 2 & 3. Zero-Compression PDF Assembler & Coordinate Rotation Engine
   * 
   * Strict details on rotations are mapped under exact image dimensions. 
   * Logs are custom syntax color-coded to look like professional Unix server builds.
   */
  const handleGeneratePDF = async () => {
    if (images.length === 0) return;

    setIsCompiling(true);
    setProgressPercent(0);
    setCompilationStep('Initializing compiler context...');
    setCompilationLog('[SYSTEM] Starting Zero-Compression PDF Assembly...\n');

    try {
      const pdfDoc = await PDFDocument.create();

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const logTime = new Date().toLocaleTimeString();
        setCompilationStep(`Processing image [${i + 1}/${images.length}]...`);
        setCompilationLog(prev => prev + `[${logTime}] [INFO] Reading Page ${i + 1}: ${img.name}\n`);

        let bytes;
        let embeddedImage;

        if (img.type === 'image/webp') {
          setCompilationLog(prev => prev + `[${logTime}] [TRANSCODE] Converting WebP losslessly into PNG bitstream...\n`);
          bytes = await convertWebPToPngBytes(img.file);
          embeddedImage = await pdfDoc.embedPng(bytes);
        } else if (img.type === 'image/png') {
          setCompilationLog(prev => prev + `[${logTime}] [EMBED] Pulling raw PNG bytes (100% untouched)...\n`);
          bytes = await readFileAsBytes(img.file);
          embeddedImage = await pdfDoc.embedPng(bytes);
        } else {
          setCompilationLog(prev => prev + `[${logTime}] [EMBED] Pulling raw JPEG bytes (100% untouched)...\n`);
          bytes = await readFileAsBytes(img.file);
          embeddedImage = await pdfDoc.embedJpg(bytes);
        }

        const W = embeddedImage.width;
        const H = embeddedImage.height;
        const rot = img.rotation;

        let pageWidth, pageHeight, drawOptions;

        // Perform exact physical spatial matrix mapping
        if (rot === 0) {
          pageWidth = W;
          pageHeight = H;
          drawOptions = { x: 0, y: 0, width: W, height: H, rotation: degrees(0) };
        } else if (rot === 90) {
          pageWidth = H;
          pageHeight = W;
          drawOptions = { x: 0, y: W, width: W, height: H, rotation: degrees(270) };
        } else if (rot === 180) {
          pageWidth = W;
          pageHeight = H;
          drawOptions = { x: W, y: H, width: W, height: H, rotation: degrees(180) };
        } else if (rot === 270) {
          pageWidth = H;
          pageHeight = W;
          drawOptions = { x: H, y: 0, width: W, height: H, rotation: degrees(90) };
        }

        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        page.drawImage(embeddedImage, drawOptions);

        setCompilationLog(prev => prev + `[${logTime}] [SUCCESS] Embedded ${W}x${H} px to Page ${i + 1} catalog.\n`);
        setProgressPercent(Math.round(((i + 0.8) / images.length) * 100));

        // Yield render block
        await new Promise(r => setTimeout(r, 60));
      }

      setCompilationStep('Structuring page index...');
      setCompilationLog(prev => prev + `[SYSTEM] Rendering final byte arrays...\n`);
      setProgressPercent(95);
      await new Promise(r => setTimeout(r, 100));

      const pdfBytes = await pdfDoc.save();

      setCompilationStep('Generating download streams...');
      setProgressPercent(100);

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `OptiMerge_ZeroLoss_${Date.now()}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
      }, 2000);

      setCompilationLog(prev => prev + `\n[COMPLETED] ✓ Assembly finished successfully! Dynamic PDF compiled losslessly.\n`);
      
      setTimeout(() => {
        setIsCompiling(false);
      }, 1500);

    } catch (err) {
      console.error(err);
      setCompilationStep('Assembly crashed!');
      setCompilationLog(prev => prev + `[FATAL] ✕ ASSEMBLY EXCEPTION: ${err.message || err}\n`);
      
      setTimeout(() => {
        setIsCompiling(false);
      }, 5000);
    }
  };

  const totalFileSize = images.reduce((acc, img) => acc + img.size, 0);

  return (
    <>
      {/* Dynamic Full Screen Drag overlay */}
      {isDraggingOverWindow && (
        <div className="global-drag-overlay">
          <div className="drag-overlay-box">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <h2>Drop to Import Pages</h2>
            <p>Your images will be uploaded instantly to the active studio session.</p>
          </div>
        </div>
      )}

      {/* Minimalist Top Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-logo-container">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          <div className="brand-info">
            <h1 className="app-title">OptiMerge Studio</h1>
            <span className="app-subtitle">Lossless Client-Side Page Compiler</span>
          </div>
        </div>
        <div className="header-badges">
          <div className="h-badge" title="Original pixels preserved 100% untouched. No server upload.">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Zero-Compression Engine
          </div>
          <div className="h-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <circle cx="12" cy="12" r="10"/>
            </svg>
            100% Client-Side Sandbox
          </div>
        </div>
      </header>

      {/* Dynamic upload dropzone collapsing */}
      <section className="upload-wrapper">
        <div
          className={`upload-zone ${images.length > 0 ? 'collapsed' : ''} ${isDraggingOverZone ? 'dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setIsDraggingOverZone(true); }}
          onDragLeave={() => setIsDraggingOverZone(false)}
          onDrop={(e) => { 
            e.preventDefault(); 
            e.stopPropagation(); 
            setIsDraggingOverZone(false); 
            setIsDraggingOverWindow(false); 
            windowDragCounter.current = 0; 
            if (e.dataTransfer.files) handleUploadFiles(e.dataTransfer.files); 
          }}
          onClick={() => document.getElementById('file-input').click()}
        >
          <input
            id="file-input"
            type="file"
            className="upload-input"
            multiple
            accept=".jpeg,.jpg,.png,.webp"
            onChange={(e) => {
              if (e.target.files) {
                handleUploadFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <div className="upload-zone-content">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div className="upload-icon-container">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <div className="upload-zone-text-group">
                <h3>{images.length > 0 ? 'Add more pages to workspace' : 'Import images to begin compiling'}</h3>
                <p>{images.length > 0 ? 'Click to browse or drop anywhere.' : 'Select or drag & drop JPEG, PNG, or WebP files here.'}</p>
              </div>
            </div>
            {!images.length && (
              <div className="upload-formats">
                <span className="format-tag">JPEG</span>
                <span className="format-tag">PNG</span>
                <span className="format-tag">WEBP (Lossless conversion)</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Floating Workspace Toolbar */}
      {images.length > 0 && (
        <section className="dashboard-actions">
          <div className="stats-container">
            <div className="stat-item">
              <span className="stat-label">Pages</span>
              <span className="stat-value">{images.length}</span>
            </div>
            <div className="stat-divider"></div>
            <div className="stat-item">
              <span className="stat-label">Total Size</span>
              <span className="stat-value">{formatFileSize(totalFileSize)}</span>
            </div>
          </div>
          
          <div className="tools-group">
            {/* Quick Sorting Hub */}
            <div className="tool-select-wrapper" title="Arrange Pages Grid">
              <select
                className="tool-select"
                onChange={(e) => {
                  handleSortQueue(e.target.value);
                  e.target.value = '';
                }}
                defaultValue=""
              >
                <option value="" disabled>Sort Catalog...</option>
                <option value="alpha-asc">Filename (A-Z)</option>
                <option value="alpha-desc">Filename (Z-A)</option>
                <option value="size-asc">File Size (Smallest)</option>
                <option value="size-desc">File Size (Largest)</option>
                <option value="dim-desc">Physical Dimensions (Largest)</option>
                <option value="shuffle">Shuffle Pages Randomly</option>
              </select>
              <svg className="tool-select-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
            
            {!showClearConfirm ? (
              <button
                className="btn btn-secondary"
                onClick={() => setShowClearConfirm(true)}
                disabled={isCompiling}
              >
                Clear Workspace
              </button>
            ) : (
              <div className="clear-confirm-group">
                <span className="clear-confirm-label">Confirm Clear?</span>
                <button
                  className="btn btn-danger btn-clear-yes"
                  onClick={handleClearWorkspace}
                  disabled={isCompiling}
                >
                  Yes
                </button>
                <button
                  className="btn btn-secondary btn-clear-cancel"
                  onClick={() => setShowClearConfirm(false)}
                  disabled={isCompiling}
                >
                  Cancel
                </button>
              </div>
            )}
            <button
              className="btn btn-primary"
              onClick={handleGeneratePDF}
              disabled={isCompiling}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              Compile PDF
            </button>
          </div>
        </section>
      )}

      {/* Workspace Area */}
      <main className="workspace-canvas">
        <div className="workspace-header-bar">
          <h2>Page Storyboard Workspace</h2>
          
          {images.length > 0 && (
            <div className="view-controls">
              <button
                className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                onClick={() => setViewMode('grid')}
              >
                Grid Grid
              </button>
              <button
                className={`view-btn ${viewMode === 'document' ? 'active' : ''}`}
                onClick={() => setViewMode('document')}
              >
                PDF Flow View
              </button>
            </div>
          )}
        </div>

        {images.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </div>
            <h3>Storyboard is vacant</h3>
            <p>Select or drag-and-drop image assets from your device to begin structuring your document spreads.</p>
            <div className="demo-trigger-container">
              <span className="demo-separator">or</span>
              <button className="btn btn-secondary btn-demo-load" onClick={loadDemoImages}>
                ⚡ Load Studio Demo Template
              </button>
            </div>
          </div>
        ) : viewMode === 'grid' ? (
          /* Grid View Mode */
          <div className="thumbnails-grid">
            {images.map((img, index) => (
              <div
                key={img.id}
                className={`thumbnail-card ${draggedIndex === index ? 'is-dragged' : ''}`}
                draggable={!isCompiling}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={handleDragOver}
                onDragEnter={(e) => handleDragEnter(e, index)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              >
                <div className="page-badge">{String(index + 1).padStart(2, '0')}</div>
                {img.rotation > 0 && <div className="rotation-badge">{img.rotation}°</div>}
                
                {/* Photoshop transparent checkerboard preview cell */}
                <div className="card-preview-area" onClick={() => setZoomedImage(img)}>
                  <div
                    className="image-transform-container"
                    style={{ transform: `rotate(${img.rotation}deg)` }}
                  >
                    <img
                      src={img.objectUrl}
                      alt={img.name}
                      className="card-preview-image"
                      loading="lazy"
                      draggable={false}
                    />
                  </div>
                </div>

                {/* Info block */}
                <div className="card-details">
                  <div className="card-filename-row">
                    <div className="card-filename" title={img.name}>{img.name}</div>
                    <span className={`card-ext-badge ext-${img.type.split('/')[1] === 'jpeg' ? 'jpg' : img.type.split('/')[1]}`}>
                      {img.type.split('/')[1] === 'jpeg' ? 'jpg' : img.type.split('/')[1]}
                    </span>
                  </div>
                  <div className="card-meta-row">
                    <span className="card-dimensions-badge">
                      {img.width} × {img.height} px
                    </span>
                    <span>{formatFileSize(img.size)}</span>
                  </div>
                </div>

                {/* Multi-Tool card operations hover slide panel */}
                <div 
                  className="card-actions-bar"
                  draggable={false}
                  onDragStart={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <button
                    className="card-action-btn"
                    title="Zoom Inspect Page"
                    onClick={() => setZoomedImage(img)}
                    disabled={isCompiling}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="11" cy="11" r="8"/>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </button>
                  <button
                    className="card-action-btn"
                    title="Rotate 90° Counter-Clockwise"
                    onClick={() => handleRotateImage(img.id, -90)}
                    disabled={isCompiling}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="1 4 1 10 7 10"/>
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                  </button>
                  <button
                    className="card-action-btn"
                    title="Rotate 90° Clockwise"
                    onClick={() => handleRotateImage(img.id, 90)}
                    disabled={isCompiling}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="23 4 23 10 17 10"/>
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </button>
                  <button
                    className="card-action-btn"
                    title="Move Page Left"
                    onClick={() => handleMoveImage(index, -1)}
                    disabled={isCompiling || index === 0}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="19" y1="12" x2="5" y2="12"/>
                      <polyline points="12 19 5 12 12 5"/>
                    </svg>
                  </button>
                  <button
                    className="card-action-btn"
                    title="Move Page Right"
                    onClick={() => handleMoveImage(index, 1)}
                    disabled={isCompiling || index === images.length - 1}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="5" y1="12" x2="19" y2="12"/>
                      <polyline points="12 5 19 12 12 19"/>
                    </svg>
                  </button>
                  <button
                    className="card-action-btn"
                    title="Duplicate Page"
                    onClick={() => handleDuplicateImage(img)}
                    disabled={isCompiling}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </button>
                  <button
                    className="card-action-btn card-btn-delete"
                    title="Delete Page"
                    onClick={() => handleDeleteImage(img.id)}
                    disabled={isCompiling}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Document Scroll Flow Mode */
          <div className="document-flow-container">
            {images.map((img, index) => (
              <div key={img.id} className="doc-page-wrapper">
                <div className="doc-page-header">
                  <div className="doc-page-title">
                    <span className="doc-page-number">Page {index + 1}</span>
                    <span className="doc-page-name">{img.name}</span>
                  </div>
                  <div className="doc-page-actions">
                    <button
                      className="btn-icon-toggle"
                      title="Rotate Page CCW"
                      onClick={() => handleRotateImage(img.id, -90)}
                      disabled={isCompiling}
                      style={{ width: '28px', height: '28px' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="1 4 1 10 7 10"/>
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                      </svg>
                    </button>
                    <button
                      className="btn-icon-toggle"
                      title="Rotate Page CW"
                      onClick={() => handleRotateImage(img.id, 90)}
                      disabled={isCompiling}
                      style={{ width: '28px', height: '28px' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="23 4 23 10 17 10"/>
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                      </svg>
                    </button>
                    <button
                      className="btn-icon-toggle"
                      title="Move Page Up"
                      onClick={() => handleMoveImage(index, -1)}
                      disabled={isCompiling || index === 0}
                      style={{ width: '28px', height: '28px' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="18 15 12 9 6 15"/>
                      </svg>
                    </button>
                    <button
                      className="btn-icon-toggle"
                      title="Move Page Down"
                      onClick={() => handleMoveImage(index, 1)}
                      disabled={isCompiling || index === images.length - 1}
                      style={{ width: '28px', height: '28px' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </button>
                    <button
                      className="btn-icon-toggle"
                      title="Duplicate Page"
                      onClick={() => handleDuplicateImage(img)}
                      disabled={isCompiling}
                      style={{ width: '28px', height: '28px' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                      </svg>
                    </button>
                    <button
                      className="btn-icon-toggle"
                      title="Delete Page"
                      onClick={() => handleDeleteImage(img.id)}
                      disabled={isCompiling}
                      style={{ width: '28px', height: '28px', color: 'var(--color-danger)' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                      </svg>
                    </button>
                  </div>
                </div>
                
                {/* Full-width aspect centering box */}
                <div className="doc-canvas-area" onClick={() => setZoomedImage(img)} style={{ cursor: 'zoom-in' }}>
                  <div
                    className="image-transform-container"
                    style={{ transform: `rotate(${img.rotation}deg)`, height: '100%' }}
                  >
                    <img
                      src={img.objectUrl}
                      alt={img.name}
                      className="card-preview-image"
                      loading="lazy"
                    />
                  </div>
                </div>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <span>Dimensions: {img.width} × {img.height} pixels</span>
                  <span>Disk Weight: {formatFileSize(img.size)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Advanced Full Screen Magnify Zoom Inspection Viewport Overlay */}
      {zoomedImage && (
        <div className="zoom-modal-backdrop" onClick={() => setZoomedImage(null)}>
          <div className="zoom-modal-header" onClick={(e) => e.stopPropagation()}>
            <div className="zoom-modal-title">
              <h3>{zoomedImage.name}</h3>
              <span>Metadata: {zoomedImage.width} × {zoomedImage.height} px | Size: {formatFileSize(zoomedImage.size)} | Format: {zoomedImage.type}</span>
            </div>
            <button className="btn-close-zoom" onClick={() => setZoomedImage(null)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div 
            className="zoom-modal-body" 
            ref={zoomModalBodyRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`zoom-modal-image-wrapper ${isPanning ? 'panning' : ''}`}
              style={{ 
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale}) rotate(${zoomedImage.rotation}deg)` 
              }}
              onMouseDown={handlePanMouseDown}
              onMouseMove={handlePanMouseMove}
              onMouseUp={handlePanMouseUpOrLeave}
              onMouseLeave={handlePanMouseUpOrLeave}
            >
              <img
                src={zoomedImage.objectUrl}
                alt={zoomedImage.name}
                className="zoom-modal-image"
              />
            </div>

            {/* Interactive Zoom Control Floating Pill */}
            <div className="zoom-controls-overlay" onClick={(e) => e.stopPropagation()}>
              <button
                className="zoom-btn"
                title="Zoom Out"
                onClick={() => setZoomScale(prev => Math.max(prev - 0.15, 0.4))}
                disabled={zoomScale <= 0.4}
              >
                —
              </button>
              <span className="zoom-scale-text">{Math.round(zoomScale * 100)}%</span>
              <button
                className="zoom-btn"
                title="Zoom In"
                onClick={() => setZoomScale(prev => Math.min(prev + 0.15, 4.0))}
                disabled={zoomScale >= 4.0}
              >
                ＋
              </button>
              <button
                className="zoom-btn-label"
                title="Reset Fit"
                onClick={() => { setZoomScale(1); setPanOffset({ x: 0, y: 0 }); }}
              >
                Fit Screen
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unix terminal-style compiler status progress modal overlay */}
      {isCompiling && (
        <div className="overlay-backdrop">
          <div className="progress-modal">
            <div className="spinner-container">
              <div className="spinner-ring"></div>
              <div className="spinner-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </div>
            </div>
            <h3>Building Document Buffer</h3>
            <p className="progress-status">{compilationStep}</p>
            
            <div className="progress-bar-wrapper">
              <div
                className="progress-bar-fill"
                style={{ width: `${progressPercent}%` }}
              ></div>
            </div>

            <div className="progress-log-box">
              {compilationLog}
            </div>
          </div>
        </div>
      )}

      {/* Page Footer */}
      <footer className="app-footer">
        <p>OptiMerge PDF Studio — Designed for Lossless Client-Side Compiles.</p>
        <p>100% Secure Sandbox. All process operations are processed within your browser stream. No servers or metrics collected.</p>
      </footer>
    </>
  );
}

export default App;
